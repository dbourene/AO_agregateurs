export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-ao-token",
};

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}