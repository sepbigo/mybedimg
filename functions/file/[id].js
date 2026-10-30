/**
 * GET /file/:id - ZYW图床 直链回源接口 (v3.0)
 *
 * 回源顺序（先缓存加速，再逐级落盘回源）：
 *   1. 边缘缓存 caches.default（纯加速层）
 *   2. Worker 内存热备（同一 isolate 的极短窗口）
 *   3. R2   file/<key>            ← 强一致主存储
 *   4. KV   blob:<key>            ← 兜底二进制
 *   5. KV   img:<key> → tgFileId  ← 索引 + Telegram 代理
 *   6. /file/tg_<file_id>.<ext>   ← 直链内嵌 file_id，零绑定也能永久读取
 *
 * 所有命中都会带上 X-ZYW-Source 响应头，方便一眼看出到底走到了哪一层。
 */

import { detectStorageBindings } from "../upload.js";

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
};

function buildImageHeaders(mimeType, fileName, source) {
  const headers = new Headers({
    "Content-Type": mimeType || "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": `inline; filename="${encodeURIComponent(fileName || "image")}"`,
  });
  if (source) headers.set("X-ZYW-Source", source);
  return headers;
}

async function fetchFromTelegram(fileId, mime, name, sourceTag) {
  const token = globalThis.__ZYW_TG_TOKEN_CACHE;
  if (!token || !fileId) return null;
  try {
    const infoResp = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const info = await infoResp.json().catch(() => null);
    const filePath = info && info.ok && info.result && info.result.file_path;
    if (!filePath) return null;

    const fileResp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(25000),
    });
    if (!fileResp.ok) return null;

    const headers = buildImageHeaders(mime, name, sourceTag || "telegram");
    headers.set("Cache-Control", "public, max-age=604800, immutable");
    return new Response(fileResp.body, { status: 200, headers });
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const { request, params, env } = context;
  const url = new URL(request.url);
  const fileKey = decodeURIComponent(params.id || "");
  const dotIdx = fileKey.lastIndexOf(".");
  const ext = (dotIdx > 0 ? fileKey.slice(dotIdx + 1) : "png").toLowerCase();
  const guessedMime = MIME_BY_EXT[ext] || "image/png";

  if (env && env.TG_BOT_TOKEN) globalThis.__ZYW_TG_TOKEN_CACHE = env.TG_BOT_TOKEN;

  const cacheKey = `${url.origin}/file/${fileKey}`;

  // ---- 1. 边缘缓存（纯加速层，命中即返回）----
  try {
    const cachedRes = await caches.default.match(new Request(cacheKey, { method: "GET" }));
    if (cachedRes) return cachedRes;
  } catch {}

  // ---- 2. 内存热备 ----
  if (globalThis.__ZYW_MEM_STORE && globalThis.__ZYW_MEM_STORE.has(fileKey)) {
    const memEntry = globalThis.__ZYW_MEM_STORE.get(fileKey);
    const headers = buildImageHeaders(
      memEntry.meta?.mime || guessedMime,
      memEntry.meta?.name || fileKey,
      "memory"
    );
    return new Response(memEntry.buffer.slice(0), { status: 200, headers });
  }

  const { kv, r2 } = detectStorageBindings(env);

  // ---- 3. 直链内嵌 Telegram file_id：/file/tg_<file_id>.<ext> ----
  if (fileKey.startsWith("tg_")) {
    const fileId = dotIdx > 3 ? fileKey.slice(3, dotIdx) : fileKey.slice(3);
    const tgRes = await fetchFromTelegram(fileId, guessedMime, fileKey, "telegram-direct");
    if (tgRes) return tgRes;
  }

  // ---- 4. R2 强一致主存储 ----
  if (r2) {
    try {
      const r2Obj = await r2.get(`file/${fileKey}`);
      if (r2Obj) {
        const mime = r2Obj.httpMetadata?.contentType || r2Obj.customMetadata?.mime || guessedMime;
        const name = r2Obj.customMetadata?.originalName || fileKey;
        return new Response(r2Obj.body, { status: 200, headers: buildImageHeaders(mime, name, "r2") });
      }
    } catch {}
  }

  // ---- 5. KV 二进制 + 索引回源 ----
  if (kv) {
    try {
      const kvBuf = await kv.get(`blob:${fileKey}`, { type: "arrayBuffer" });
      if (kvBuf && kvBuf.byteLength > 0) {
        return new Response(kvBuf, {
          status: 200,
          headers: buildImageHeaders(guessedMime, fileKey, "kv"),
        });
      }
    } catch {}

    try {
      const metaRaw = await kv.get(`img:${fileKey}`);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        const mime = meta.mime || guessedMime;
        const name = meta.name || fileKey;

        if (meta.r2Key && r2) {
          const obj = await r2.get(meta.r2Key);
          if (obj) {
            return new Response(obj.body, { status: 200, headers: buildImageHeaders(mime, name, "kv-index-r2") });
          }
        }

        if (meta.tgFileId) {
          const tgRes = await fetchFromTelegram(meta.tgFileId, mime, name, "kv-index-telegram");
          if (tgRes) return tgRes;
        }
      }
    } catch {}
  }

  // ---- 6. 兜底：若带 tg_ 前缀但上面 KV 检查前没命中，这里再试一次 ----
  if (!fileKey.startsWith("tg_") && env && env.TG_BOT_TOKEN) {
    // 无索引记录时无法反查 file_id，直接返回 404
  }

  return Response.json(
    {
      error: "Image not found",
      code: "file_not_found",
      key: fileKey,
      hint:
        "该 Key 在 R2 / KV / Telegram 中均不存在。若上传时间较早，说明上传时未绑定任何持久化存储，" +
        "请重新上传；并检查 Pages 项目的 R2 绑定（Settings → Bindings）。",
      bindings: { r2: !!r2, kv: !!kv, telegram: !!(env && env.TG_BOT_TOKEN) },
    },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}
