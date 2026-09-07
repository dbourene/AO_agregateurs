import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { signToken } from "../_shared/token.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Comparaison à temps constant (même esprit que ao-auth)
function constantTimeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(); const ab = e.encode(a), bb = e.encode(b);
  if (ab.length !== bb.length) return false;
  let d = 0; for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

// Découpe [start, end] en tranches <= 1 mois calendaire (contrainte API RTE)
function monthlySlices(startMs: number, endMs: number): Array<{ s: string; e: string }> {
  const out: Array<{ s: string; e: string }> = [];
  let cur = startMs;
  while (cur < endMs) {
    const d = new Date(cur);
    // +1 mois calendaire, borné par endMs
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
    const sliceEnd = Math.min(next, endMs);
    out.push({ s: new Date(cur).toISOString(), e: new Date(sliceEnd).toISOString() });
    cur = sliceEnd;
  }
  return out;
}

// Appelle une autre Edge Function du même projet avec un X-AO-Token forgé
async function callFetch(fnName: string, xaoToken: string, start: string, end: string) {
  const baseUrl = Deno.env.get("SUPABASE_URL")!; // .../functions/v1/<fn>
  const r = await fetch(`${baseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AO-Token": xaoToken },
    body: JSON.stringify({ start_date: start, end_date: end }),
  });
  const detail = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, detail };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // --- Auth cron : header dédié, distinct du flux utilisateur ---
  const CRON_SECRET = Deno.env.get("AO_CRON_SECRET");
  const TOKEN_SECRET = Deno.env.get("AO_TOKEN_SECRET");
  if (!CRON_SECRET || !TOKEN_SECRET) return json({ error: "server_misconfigured" }, 500);
  const provided = req.headers.get("x-ao-cron-secret") ?? "";
  if (!constantTimeEqual(provided, CRON_SECRET)) return json({ error: "unauthorized" }, 401);

  // --- Fenêtre : now-60j -> now (UTC) ---
  const now = Date.now();
  const DAY = 86400000;
  const windowStart = now - 60 * DAY;
  const startIso = new Date(windowStart).toISOString();
  const endIso = new Date(now).toISOString();

  // Token court pour appeler ao-fetch-*
  const xao = await signToken(TOKEN_SECRET, 600); // 10 min suffisent

  const report: Record<string, unknown> = { window: { start: startIso, end: endIso } };

  // --- PREP : tranches <= 1 mois ---
  try {
    const slices = monthlySlices(windowStart, now);
    const prepResults = [];
    for (const sl of slices) {
      const res = await callFetch("ao-fetch-prep", xao, sl.s, sl.e);
      prepResults.push({ slice: sl, ...res });
      if (!res.ok) break; // on s'arrête à la 1re erreur PREP, mais on n'empêche pas EPEX
    }
    report.prep = prepResults;
  } catch (e) {
    report.prep = { error: String((e as any)?.message ?? e) };
  }

  // --- EPEX : un seul appel sur 60 j ---
  try {
    report.epex = await callFetch("ao-fetch-epex", xao, startIso, endIso);
  } catch (e) {
    report.epex = { error: String((e as any)?.message ?? e) };
  }

  // --- Purge : start_date < now - 13 mois ---
  try {
    const purgeBefore = new Date(Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth() - 13,
      new Date(now).getUTCDate(),
    )).toISOString();
    const db = adminClient();
    const { error, count } = await db
      .from("ao_prix_marche")
      .delete({ count: "exact" })
      .lt("start_date", purgeBefore);
    if (error) throw error;
    report.purge = { before: purgeBefore, deleted: count ?? null };
  } catch (e) {
    report.purge = { error: String((e as any)?.message ?? e) };
  }

  return json({ ok: true, ...report });
});