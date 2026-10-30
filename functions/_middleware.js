/**
 * ZYW图床 全局安全与门禁中间件 (Cloudflare Pages Functions v2.1)
 * - 全路径认证门禁保护
 * - 对 /file/* 图片直链放行跨站引用 (Cross-Origin-Resource-Policy: cross-origin)，确保 BBCode 论坛与外部博客正常加载图片
 * - 对管理与上传 API 实施同源 CSRF 保护与 HSTS 安全响应头
 */

const PUBLIC_PATHS = new Set([
  "/upload-login",
  "/upload-login.html",
  "/api/upload-auth/login",
  "/api/upload-auth/session",
  "/api/upload-auth/logout",
  "/api/bing/wallpaper",
  "/robots.txt",
  "/manifest.json",
  "/favicon.ico",
]);

const KNOWN_APP_PATHS = new Set([
  "/",
  "/index",
  "/index.html",
  "/markdown-upload",
  "/markdown-upload.html",
  "/upload-login",
  "/upload-login.html",
  "/upload",
  "/api/upload-auth/session",
  "/api/upload-auth/login",
  "/api/upload-auth/logout",
  "/api/bing/wallpaper",
  "/api/manage/list",
  "/api/storage/status",
  "/robots.txt",
  "/manifest.json",
  "/favicon.ico",
]);

export async function verifySessionCookie(request, env) {
  if (!env.UPLOAD_AUTH_PASSWORD) return true; // 未设置密码时默认开放上传
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)zyw_session=([^;]+)/);
  if (!match) return false;

  const token = match[1];
  const secret = env.SESSION_SECRET || env.UPLOAD_AUTH_PASSWORD;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode("zyw_authenticated_v2")
  );
  const expectedHex = Array.from(new Uint8Array(expectedSigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return token === expectedHex;
}

export function applySecurityHeaders(response, requestUrl, isFileRoute = false) {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  headers.set("X-Content-Type-Options", "nosniff");

  if (isFileRoute) {
    // 允许外部论坛 (BBCode)、博客 (Markdown/HTML) 跨域引用图片直链
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  } else {
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
    headers.set("Access-Control-Allow-Origin", requestUrl.origin);
    headers.set("Vary", "Origin");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isFileRoute = pathname.startsWith("/file/");

  // 1. 校验非幂等请求的同源性 (防 CSRF)
  if (["POST", "PUT", "DELETE", "PATCH"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return applySecurityHeaders(
        Response.json(
          { error: "Cross-site request blocked by security policy", code: "cross_site_request" },
          { status: 403 }
        ),
        url
      );
    }
  }

  // 2. 真实 404 拦截
  const isStaticAsset = pathname.startsWith("/assets/") || isFileRoute;
  if (!isStaticAsset && !KNOWN_APP_PATHS.has(pathname)) {
    return applySecurityHeaders(
      Response.json(
        { error: "Not Found", code: "route_not_found", path: pathname },
        { status: 404 }
      ),
      url
    );
  }

  // 3. 公开路径或图片直链读取直接放行
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/assets/") || isFileRoute) {
    const res = await next();
    return applySecurityHeaders(res, url, isFileRoute);
  }

  // 4. 全路径访问门禁校验
  const isAuthed = await verifySessionCookie(request, env);
  if (!isAuthed) {
    if (pathname.startsWith("/api/") || pathname === "/upload") {
      return applySecurityHeaders(
        Response.json(
          { error: "Upload authentication is required", code: "upload_auth_required" },
          { status: 401, headers: { "Cache-Control": "private, no-store" } }
        ),
        url
      );
    }
    const returnTo = encodeURIComponent(pathname === "/markdown-upload" ? "/markdown-upload" : "/");
    return Response.redirect(`${url.origin}/upload-login.html?returnTo=${returnTo}`, 302);
  }

  const response = await next();
  return applySecurityHeaders(response, url, false);
}
