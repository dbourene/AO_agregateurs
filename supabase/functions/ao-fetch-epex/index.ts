import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireAuth, adminClient } from "../_shared/auth.ts";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4.3.6";

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const ZONE = "10YFR-RTE------C"; // France
function compactUTC(iso: string) {
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
const arr = (x: any) => Array.isArray(x) ? x : (x == null ? [] : [x]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await requireAuth(req))) return json({ error: "unauthorized" }, 401);

  let p: { start_date?: string; end_date?: string } = {};
  try { p = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (!p.start_date || !p.end_date) return json({ error: "start_date/end_date requis" }, 400);

  const token = Deno.env.get("ENTSOE_TOKEN");
  if (!token) return json({ error: "ENTSOE_TOKEN manquant" }, 500);

  const base = `https://web-api.tp.entsoe.eu/api?documentType=A44&in_Domain=${ZONE}&out_Domain=${ZONE}`
    + `&periodStart=${compactUTC(p.start_date)}&periodEnd=${compactUTC(p.end_date)}&securityToken=${token}`;

  try {
    let r = await fetch(base);
    if (r.status === 400) r = await fetch(base + "&BusinessType=A62"); // repli bug ENTSO-E
    const xml = await r.text();
    if (!r.ok) return json({ error: "entsoe_error", status: r.status, detail: xml.slice(0, 400) }, 502);

    const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
    if (doc.Acknowledgement_MarketDocument) {
      const reason = doc.Acknowledgement_MarketDocument?.Reason?.text || "refus ENTSO-E";
      return json({ error: "entsoe_ack", detail: String(reason) }, 502);
    }
    const root = doc.Publication_MarketDocument;
    if (!root) return json({ error: "format_inattendu", detail: xml.slice(0, 300) }, 502);

    // map clé = ISO 15 min UTC ; valeur = {price, res} ; PT15M prioritaire sur PT60M
    const map = new Map<string, { price: number | null; res: string }>();
    for (const ts of arr(root.TimeSeries)) {
      for (const per of arr(ts.Period)) {
        const res = per.resolution;
        const stepSec = res === "PT15M" ? 900 : res === "PT30M" ? 1800 : 3600;
        const startMs = Date.parse(per.timeInterval.start);
        const endMs = Date.parse(per.timeInterval.end);
        const n = Math.round((endMs - startMs) / 1000 / stepSec);
        const prices = new Array(n + 1).fill(null);
        for (const pt of arr(per.Point)) prices[+pt.position] = Number(pt["price.amount"]);
        let last: number | null = null;
        for (let i = 1; i <= n; i++) { if (prices[i] == null) prices[i] = last; else last = prices[i]; }
        const slots = stepSec / 900; // 1 (15min), 2 (30min), 4 (60min)
        for (let i = 1; i <= n; i++) {
          for (let j = 0; j < slots; j++) {
            const ms = startMs + ((i - 1) * slots + j) * 900000;
            const key = new Date(ms).toISOString();
            const ex = map.get(key);
            if (!ex || (ex.res !== "PT15M" && res === "PT15M")) map.set(key, { price: prices[i], res });
          }
        }
      }
    }

    const rows = [...map.entries()].map(([key, v]) => ({
      source: "epex",
      start_date: key,
      end_date: new Date(Date.parse(key) + 900000).toISOString(),
      prix_eur_mwh: v.price,
      resolution: "PT15M",
    }));

    const db = adminClient();
    let nIns = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await db.from("ao_prix_marche").upsert(chunk, { onConflict: "source,start_date,resolution" });
      if (error) throw error;
      nIns += chunk.length;
    }
    return json({ ok: true, inserted: nIns });
  } catch (e) {
    return json({ error: "fetch_failed", detail: String((e as any)?.message ?? e) }, 500);
  }
});