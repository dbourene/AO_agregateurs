import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { signToken } from "../_shared/token.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function constantTimeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const ab = e.encode(a), bb = e.encode(b);
  if (ab.length !== bb.length) return false;
  let d = 0; for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const APP_PASSWORD = Deno.env.get("AO_APP_PASSWORD");
  const TOKEN_SECRET = Deno.env.get("AO_TOKEN_SECRET");
  if (!APP_PASSWORD || !TOKEN_SECRET) return json({ error: "server_misconfigured" }, 500);

  let body: { password?: string } = {};
  try { body = await req.json(); } catch { /* body vide */ }

  if (!constantTimeEqual(body.password ?? "", APP_PASSWORD)) {
    return json({ error: "invalid_password" }, 401);
  }
  const token = await signToken(TOKEN_SECRET, 7200);
  return json({ token, expires_in: 7200 });
});