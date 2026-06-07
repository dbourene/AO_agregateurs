import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { verifyToken } from "./token.ts";

export async function requireAuth(req: Request): Promise<boolean> {
  const secret = Deno.env.get("AO_TOKEN_SECRET");
  if (!secret) return false;
  const token = req.headers.get("X-AO-Token") ?? "";
  if (!token) return false;
  return await verifyToken(secret, token);
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}