import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireAuth, adminClient } from "../_shared/auth.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function rteToken(): Promise<string> {
  const id = Deno.env.get("RTE_CLIENT_ID");
  const sec = Deno.env.get("RTE_CLIENT_SECRET");
  if (!id || !sec) throw new Error("Identifiants RTE manquants (secrets)");
  const basic = btoa(`${id}:${sec}`);
  const r = await fetch("https://digital.iservices.rte-france.com/token/oauth/", {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!r.ok) throw new Error(`Token RTE refusé (${r.status})`);
  return (await r.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await requireAuth(req))) return json({ error: "unauthorized" }, 401);

  let p: { start_date?: string; end_date?: string } = {};
  try { p = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (!p.start_date || !p.end_date) return json({ error: "start_date/end_date requis" }, 400);

  try {
    const token = await rteToken();
    const url = `https://digital.iservices.rte-france.com/open_api/balancing_energy/v5/imbalance_data`
      + `?start_date=${encodeURIComponent(p.start_date)}&end_date=${encodeURIComponent(p.end_date)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) {
      const txt = await r.text();
      return json({ error: "rte_error", status: r.status, detail: txt.slice(0, 400) }, 502);
    }
    const data = await r.json();
    const groups = data.imbalance_data || [];
    const rows: any[] = [];
    for (const g of groups) {
      const resolution = g.resolution || "PT15M";
      for (const v of (g.values || [])) {
        rows.push({
          source: "prep",
          start_date: v.start_date,
          end_date: v.end_date,
          prix_eur_mwh: v.positive_imbalance_settlement_price, // PREP (peut être null si non calculé)
          resolution,
        });
      }
    }
    const db = adminClient();
    let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await db.from("ao_prix_marche")
        .upsert(chunk, { onConflict: "source,start_date,resolution" });
      if (error) throw error;
      n += chunk.length;
    }
    return json({ ok: true, inserted: n, groups: groups.length });
  } catch (e) {
    return json({ error: "fetch_failed", detail: String(e?.message ?? e) }, 500);
  }
});