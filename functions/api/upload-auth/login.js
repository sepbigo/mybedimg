/**
 * POST /api/upload-auth/login - 带 IP 速率限制与防爆破保护的认证接口
 * 修复分析报告五.2：增加每 IP 10 分钟最多 5 次失败尝试的速率限制（超限返回 429）
 */

const ALLOWED_PATHS = new Set([
  "/",
  "/index",
  "/index.html",
  "/markdown-upload",
  "/markdown-upload.html",
]);

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.UPLOAD_AUTH_PASSWORD) {
    return Response.json(
      { authenticated: false, code: "upload_auth_not_configured" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const clientIp = request.headers.get("CF-Connecting-IP") || "local";
  const rateKey = `ratelimit:login:${clientIp}`;

  if (env.IMAGE_INDEX) {
    const attempts = parseInt((await env.IMAGE_INDEX.get(rateKey)) || "0", 10);
    if (attempts >= 5) {
      return Response.json(
        {
          authenticated: false,
          code: "rate_limit_exceeded",
          error: "登录尝试过于频繁，请 10 分钟后再试。",
        },
        { status: 429, headers: { "Retry-After": "600", "Cache-Control": "private, no-store" } }
      );
    }
  }

  const formData = await request.formData().catch(() => null);
  const password = formData ? (formData.get("password") || "").toString() : "";
  const requestedReturnTo = formData ? (formData.get("returnTo") || "/").toString() : "/";
  const redirectTo = ALLOWED_PATHS.has(requestedReturnTo) ? requestedReturnTo : "/";

  if (password !== env.UPLOAD_AUTH_PASSWORD) {
    if (env.IMAGE_INDEX) {
      const current = parseInt((await env.IMAGE_INDEX.get(rateKey)) || "0", 10);
      await env.IMAGE_INDEX.put(rateKey, String(current + 1), { expirationTtl: 600 });
    }
    return Response.json(
      { authenticated: false, code: "upload_auth_required" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  if (env.IMAGE_INDEX) {
    await env.IMAGE_INDEX.delete(rateKey);
  }

  const secret = env.SESSION_SECRET || env.UPLOAD_AUTH_PASSWORD;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode("zyw_authenticated_v2"));
  const token = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return Response.json(
    { authenticated: true, redirectTo },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": `zyw_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
      },
    }
  );
}
