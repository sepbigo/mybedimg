/**
 * GET / DELETE /api/manage/list - ZYW图床 自适应图库列表接口 (v3.1)
 *
 * v3.1 变更：
 *   未绑定 KV 时，旧版只能返回当前 isolate 内存里最多 50 张（刷新即空）。
 *   现在改为以 R2 对象枚举为**主数据源**（r2.list 的 customMetadata 里就有
 *   原始文件名/尺寸/相册），KV 索引只作为补充覆盖，因此零 KV 也能看到完整图库。
 */

import { detectStorageBindings } from "../../upload.js";

const MAX_PAGES = 10; // 最多扫描 10000 个对象，防止超时

function formatDateTime(input) {
  if (!input) return "";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function buildRecordFromR2(key, obj) {
  const meta = obj.customMetadata || {};
  const httpMeta = obj.httpMetadata || {};
  const path = `/file/${key}`;
  const name = meta.originalName || key;
  return {
    id: key.split(".")[0],
    key,
    r2Key: `file/${key}`,
    name,
    size: obj.size,
    dimensions: meta.dimensions || "",
    mime: meta.mime || httpMeta.contentType || "",
    album: meta.album || "default",
    storage: "R2",
    durable: true,
    createdAt: formatDateTime(obj.uploaded),
    src: path,
    path,
    links: {
      url: path,
      markdown: `![${name}](${path})`,
      html: `<img src="${path}" alt="${name}" loading="lazy" />`,
      bbcode: `[img]${path}[/img]`,
    },
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const { kv, r2 } = detectStorageBindings(env);
  const itemsMap = new Map();

  // ---- 1. 内存热备（仅有当前 isolate 的极短窗口，放最前面便于覆盖）----
  if (globalThis.__ZYW_MEM_STORE) {
    for (const [key, entry] of globalThis.__ZYW_MEM_STORE.entries()) {
      if (entry && entry.meta) itemsMap.set(key, entry.meta);
    }
  }

  // ---- 2. R2 对象枚举（主数据源，零 KV 也能列全）----
  if (r2 && typeof r2.list === "function") {
    try {
      let cursor;
      let page = 0;
      do {
        const listed = await r2.list({
          prefix: "file/",
          limit: 1000,
          cursor,
          include: ["httpMetadata", "customMetadata"],
        });
        for (const obj of listed.objects || []) {
          const key = String(obj.key).replace(/^file\//, "");
          if (!key || key.startsWith("_healthcheck")) continue;
          const existing = itemsMap.get(key);
          // 内存里的记录字段更全（含 links / durable），只在缺失时用 R2 补
          itemsMap.set(key, existing ? { ...buildRecordFromR2(key, obj), ...existing } : buildRecordFromR2(key, obj));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
        page++;
      } while (cursor && page < MAX_PAGES);
    } catch {}
  }

  // ---- 3. KV 索引（补充 Telegram 直链等 R2 里没有的字段）----
  if (kv) {
    try {
      const listResult = await kv.list({ prefix: "img:", limit: 500 });
      for (const keyObj of listResult.keys) {
        const val = await kv.get(keyObj.name);
        if (val) {
          const parsed = JSON.parse(val);
          const key = parsed.key || keyObj.name.replace("img:", "");
          itemsMap.set(key, { ...(itemsMap.get(key) || {}), ...parsed });
        }
      }
    } catch {}
  }

  const items = Array.from(itemsMap.values());
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  return Response.json(
    {
      status: 200,
      total: items.length,
      source: { r2: !!r2, kv: !!kv, memory: !!globalThis.__ZYW_MEM_STORE },
      data: items,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const { kv, r2 } = detectStorageBindings(env);
  const body = await request.json().catch(() => ({}));
  const key = body.key;
  if (!key) {
    return Response.json({ error: "Missing file key", code: "file_missing" }, { status: 400 });
  }

  if (globalThis.__ZYW_MEM_STORE) {
    globalThis.__ZYW_MEM_STORE.delete(key);
  }
  if (r2) {
    try {
      await r2.delete(`file/${key}`);
    } catch {}
  }
  if (kv) {
    try {
      await kv.delete(`img:${key}`);
      await kv.delete(`blob:${key}`);
    } catch {}
  }

  // 同步清除边缘缓存，避免删除后直链仍然可访问
  try {
    const origin = new URL(request.url).origin;
    await caches.default.delete(new Request(`${origin}/file/${key}`, { method: "GET" }));
  } catch {}

  return Response.json({ status: 200, deleted: key });
}
