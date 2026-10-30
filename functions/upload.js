/**
 * POST /upload - ZYW图床 持久化多引擎上传接口 (v3.0)
 *
 * ⚠️ v2.3 的致命缺陷（已修复）：
 *    旧版在「既没有绑定 R2 也没有绑定 KV」时，仍然把文件只写进
 *    caches.default（单机房边缘缓存，随时被驱逐、不跨机房共享）和
 *    globalThis 内存（Worker isolate，随时回收），然后返回"上传成功"。
 *    结果就是：刚上传时同一个机房能打开，几分钟到几小时后必然 404。
 *
 * ✅ v3.0 写入链（按可靠性排序，全部落盘后才算成功）：
 *    1. Cloudflare R2（强一致，最佳）
 *    2. Cloudflare KV（最终一致，单值上限 25MB）
 *    3. Telegram Bot（永久 file_id，直链内嵌 /file/tg_<file_id>.<ext>）
 *    4. 三者全部失败 → 降级为易失模式，返回 durable:false 明确告知前端
 *
 * 每次写入后都会「回读校验」，不再出现「接口返回成功但对象没落盘」。
 */

const KV_MAX_BYTES = 25 * 1024 * 1024;
const TG_MAX_BYTES = 20 * 1024 * 1024; // Bot API getFile 下载上限 20MB

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "video/mp4": "mp4",
};

function errorJson(code, message, status = 400) {
  return Response.json({ error: message, code }, { status });
}

/* ------------------------------------------------------------------ *
 * 绑定探测
 * ------------------------------------------------------------------ */

// R2Bucket 有 head / createMultipartUpload，且**没有** getWithMetadata
function isR2Binding(v) {
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.get === "function" &&
    typeof v.put === "function" &&
    typeof v.head === "function" &&
    typeof v.getWithMetadata !== "function"
  );
}

// KVNamespace 有 getWithMetadata，且**没有** head
function isKVBinding(v) {
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.get === "function" &&
    typeof v.put === "function" &&
    typeof v.getWithMetadata === "function" &&
    typeof v.head !== "function"
  );
}

const R2_HINTS = ["ZYW_R2_BUCKET", "R2_BUCKET", "R2", "BUCKET", "IMAGES", "IMG_BUCKET", "zyw-images"];
const KV_HINTS = ["IMAGE_INDEX", "ZYW_KV", "IMG_KV", "IMAGE_KV", "KV", "zyw-kv"];

/**
 * 自动识别 env 中绑定的任意 KV 命名空间与 R2 存储桶（无论变量名叫什么都能识别）
 * @returns {{kv: any|null, r2: any|null, names: {kv: string|null, r2: string|null}}}
 */
export function detectStorageBindings(env) {
  const out = { kv: null, r2: null, names: { kv: null, r2: null } };
  if (!env || typeof env !== "object") return out;

  // 1) 先按常见变量名精确命中
  for (const name of R2_HINTS) {
    if (!out.r2 && isR2Binding(env[name])) {
      out.r2 = env[name];
      out.names.r2 = name;
    }
  }
  for (const name of KV_HINTS) {
    if (!out.kv && isKVBinding(env[name])) {
      out.kv = env[name];
      out.names.kv = name;
    }
  }
  if (out.r2 && out.kv) return out;

  // 2) 再按对象特征全量扫描兜底
  for (const [name, val] of Object.entries(env)) {
    if (!out.r2 && isR2Binding(val)) {
      out.r2 = val;
      out.names.r2 = name;
    } else if (!out.kv && isKVBinding(val)) {
      out.kv = val;
      out.names.kv = name;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 写入校验
 * ------------------------------------------------------------------ */

async function verifyR2Object(r2, key, expectedSize) {
  try {
    const head = await r2.head(key);
    if (!head) return false;
    if (typeof expectedSize === "number" && typeof head.size === "number" && head.size !== expectedSize) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyKvObject(kv, key) {
  try {
    const stream = await kv.get(key, { type: "stream", cacheTtl: 60 });
    if (!stream) return false;
    try {
      if (typeof stream.cancel === "function") await stream.cancel();
    } catch {}
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Telegram
 * ------------------------------------------------------------------ */

async function uploadToTelegram(fileBuffer, fileName, mimeType, env) {
  if (!env || !env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return null;
  if (fileBuffer.byteLength > TG_MAX_BYTES) return null;

  try {
    const tgForm = new FormData();
    tgForm.append("chat_id", env.TG_CHAT_ID);
    const isVideo = mimeType === "video/mp4";
    const endpoint = isVideo ? "sendVideo" : "sendDocument";
    const blob = new Blob([fileBuffer], { type: mimeType || "application/octet-stream" });
    tgForm.append(isVideo ? "video" : "document", blob, fileName || "upload.png");

    const resp = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`, {
      method: "POST",
      body: tgForm,
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (!data || !data.ok || !data.result) return null;

    const doc =
      data.result.document ||
      data.result.video ||
      (Array.isArray(data.result.photo) ? data.result.photo[data.result.photo.length - 1] : null);
    return doc && doc.file_id ? doc.file_id : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 上传主流程
 * ------------------------------------------------------------------ */

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const { kv, r2, names } = detectStorageBindings(env);

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorJson("invalid_form_data", "Invalid multipart/form-data payload", 400);
  }

  const rawFiles = [...formData.getAll("file"), ...formData.getAll("files")].filter(Boolean);
  if (rawFiles.length === 0) {
    return errorJson("file_missing", "No file found in upload request", 400);
  }

  const maxBytes = (parseInt((env && env.MAX_FILE_SIZE_MB) || "25", 10) || 25) * 1024 * 1024;
  const album = (formData.get("album") || "default").toString().slice(0, 32);
  const dimensions = (formData.get("dimensions") || "1920×1080").toString().slice(0, 32);

  if (!globalThis.__ZYW_MEM_STORE) {
    globalThis.__ZYW_MEM_STORE = new Map();
  }

  const results = [];

  for (const file of rawFiles) {
    if (typeof file === "string" || typeof file.size !== "number") {
      return errorJson("invalid_form_data", "Uploaded entry is not a valid binary file", 400);
    }
    if (file.size === 0) {
      return errorJson("file_empty", "Uploaded file is empty", 400);
    }
    if (file.size > maxBytes) {
      return errorJson("file_too_large", `File exceeds maximum allowed size (${maxBytes} bytes)`, 413);
    }

    const mimeType = file.type || "image/png";
    const nameExt = file.name && file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
    const ext = EXT_BY_MIME[mimeType] || nameExt || "png";
    const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const fileKey = `${shortId}.${ext}`;

    const fileBuffer = await file.arrayBuffer();
    const byteLength = fileBuffer.byteLength;

    let r2Stored = false;
    let kvStored = false;
    let tgFileId = null;

    // ---- 1. R2（强一致首选）----
    if (r2) {
      try {
        await r2.put(`file/${fileKey}`, fileBuffer.slice(0), {
          httpMetadata: { contentType: mimeType },
          customMetadata: {
            originalName: file.name || fileKey,
            album,
            mime: mimeType,
            dimensions,
          },
        });
        r2Stored = await verifyR2Object(r2, `file/${fileKey}`, byteLength);
      } catch {
        r2Stored = false;
      }
    }

    // ---- 2. KV（R2 未就绪时兜底）----
    if (!r2Stored && kv && byteLength <= KV_MAX_BYTES) {
      try {
        await kv.put(`blob:${fileKey}`, fileBuffer.slice(0), {
          metadata: { mime: mimeType, name: file.name || fileKey },
        });
        kvStored = await verifyKvObject(kv, `blob:${fileKey}`);
      } catch {
        kvStored = false;
      }
    }

    // ---- 3. Telegram（无任何绑定时的持久化方案）----
    const tgAlways = env && env.TG_ALWAYS === "1";
    if ((!r2Stored && !kvStored) || tgAlways) {
      tgFileId = await uploadToTelegram(fileBuffer, file.name || fileKey, mimeType, env);
    }

    // ---- 4. 决定直链形态 ----
    const durable = r2Stored || kvStored || !!tgFileId;
    let publicPath;
    let storageLabel;

    if (r2Stored) {
      publicPath = `/file/${fileKey}`;
      storageLabel = kvStored ? "R2+KV" : "R2";
    } else if (kvStored) {
      publicPath = `/file/${fileKey}`;
      storageLabel = "KV";
    } else if (tgFileId) {
      // 直链内嵌 file_id，无需任何 KV/R2 也能永久回源
      publicPath = `/file/tg_${tgFileId}.${ext}`;
      storageLabel = "Telegram";
    } else {
      publicPath = `/file/${fileKey}`;
      storageLabel = "临时缓存";
    }

    const fullUrl = `${url.origin}${publicPath}`;

    // ---- 5. 仅在持久化成功时写边缘缓存（纯加速，不作为存储依据）----
    if (durable) {
      try {
        const cacheReq = new Request(`${url.origin}/file/${fileKey}`, { method: "GET" });
        const cacheRes = new Response(fileBuffer.slice(0), {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Content-Disposition": `inline; filename="${encodeURIComponent(file.name || fileKey)}"`,
          },
        });
        await caches.default.put(cacheReq, cacheRes);
        const altReq = new Request(fullUrl, { method: "GET" });
        if (fullUrl !== `${url.origin}/file/${fileKey}`) {
          await caches.default.put(altReq, cacheRes.clone());
        }
      } catch {}
    }

    const record = {
      id: shortId,
      key: fileKey,
      r2Key: r2Stored ? `file/${fileKey}` : null,
      tgFileId,
      kvStored,
      r2Stored,
      durable,
      storageEngine: storageLabel,
      name: file.name || fileKey,
      size: file.size,
      dimensions,
      mime: mimeType,
      album,
      storage: storageLabel,
      createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      src: publicPath,
      path: publicPath,
      links: {
        url: fullUrl,
        markdown: `![${file.name || fileKey}](${fullUrl})`,
        html: `<img src="${fullUrl}" alt="${file.name || fileKey}" loading="lazy" />`,
        bbcode: `[img]${fullUrl}[/img]`,
      },
    };

    if (!durable) {
      record.warning =
        "未检测到任何持久化存储（R2 / KV / Telegram），此链接为临时缓存，几分钟到几小时后会 404。" +
        "请在 Cloudflare Pages 项目 Settings → Bindings 中绑定 R2 存储桶，或配置 TG_BOT_TOKEN + TG_CHAT_ID。";
    }

    // ---- 6. 内存热备（仅用于当前 isolate 的极短窗口）----
    globalThis.__ZYW_MEM_STORE.set(fileKey, { buffer: fileBuffer, meta: record });
    if (globalThis.__ZYW_MEM_STORE.size > 50) {
      const oldestKey = globalThis.__ZYW_MEM_STORE.keys().next().value;
      globalThis.__ZYW_MEM_STORE.delete(oldestKey);
    }

    // ---- 7. 写 KV 索引记录（供图库列表使用）----
    if (kv) {
      try {
        await kv.put(`img:${fileKey}`, JSON.stringify(record));
      } catch {}
    }

    results.push(record);
  }

  const allDurable = results.every((r) => r.durable);
  const headers = { "Cache-Control": "no-store" };
  if (!allDurable) {
    headers["X-ZYW-Storage-Warning"] = "ephemeral";
  }
  if (names.r2) headers["X-ZYW-R2-Binding"] = names.r2;
  if (names.kv) headers["X-ZYW-KV-Binding"] = names.kv;

  return Response.json(results, { status: 200, headers });
}
