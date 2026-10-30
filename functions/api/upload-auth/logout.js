export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${url.origin}/upload-login?loggedOut=1`,
      "Set-Cookie": "zyw_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      "Cache-Control": "private, no-store",
    },
  });
}
