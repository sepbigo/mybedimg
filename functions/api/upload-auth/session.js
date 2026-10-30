import { verifySessionCookie } from "../../_middleware.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authenticated = await verifySessionCookie(request, env);
  if (!authenticated) {
    return Response.json(
      { authenticated: false, code: "upload_auth_required" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  return Response.json(
    { authenticated: true, site: env.SITE_NAME || "ZYW图床" },
    { status: 200, headers: { "Cache-Control": "private, no-store" } }
  );
}
