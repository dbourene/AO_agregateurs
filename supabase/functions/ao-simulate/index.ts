import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireAuth, adminClient } from "../_shared/auth.ts";

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// horodatage (UTC) -> position 30 min dans la courbe, calée sur l'heure LOCALE Paris
const PARIS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function idx30(iso: string): number {
  const parts = PARIS.formatToParts(new Date(iso));
  const g = (t: string) => +parts.find((x) => x.type === t)!.value;
  const mon = g("month"), day = g("day"), hour = g("hour"), min = g("minute");
  const doy = CUM[mon - 1] + (day - 1);
  return doy * 48 + hour * 2 + (min >= 30 ? 1 : 0);
}
function monthParis(iso: string): number {
  return +PARIS.formatToParts(new Date(iso)).find((x) => x.type === "month")!.value;
}

const hSum = (h: any[], t: string, f: string) => h.filter((x) => x.type === t).reduce((a, x) => a + (Number(x.params?.[f]) || 0), 0);
const hMax = (h: any[], t: string, f: string) => { const xs = h.filter((x) => x.type === t).map((x) => Number(x.params?.[f]) || 0); return xs.length ? Math.max(...xs) : null; };
const hFind = (h: any[], t: string) => h.find((x) => x.type === t);

async function fetchMarket(db: any, source: string) {
  const out: any[] = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await db.from("ao_prix_marche")
      .select("start_date,prix_eur_mwh").eq("source", source)
      .order("start_date", { ascending: true }).range(from, from + size - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await requireAuth(req))) return json({ error: "unauthorized" }, 401);

  let body: { courbe_id?: string; agregateur_ids?: string[] } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  if (!body.courbe_id || !Array.isArray(body.agregateur_ids) || !body.agregateur_ids.length)
    return json({ error: "courbe_id et agregateur_ids requis" }, 400);

  try {
    const db = adminClient();
    const { data: courbe, error: e1 } = await db.from("ao_courbes_charge").select("*").eq("id", body.courbe_id).single();
    if (e1) throw e1;
    const { data: aggs, error: e2 } = await db.from("ao_agregateurs").select("*").in("id", body.agregateur_ids);
    if (e2) throw e2;

    const prep = await fetchMarket(db, "prep");
    let epex: any[] = [];
    const needEpex = aggs.some((a: any) => a.prix_base === "epex");
    if (needEpex) epex = await fetchMarket(db, "epex");

    const points: number[] = Array.isArray(courbe.points) ? courbe.points : [];
    const kwc = courbe.puissance_kwc != null ? Number(courbe.puissance_kwc) : null;
    const notes: string[] = [];

    const results = aggs.map((a: any) => {
      const hon = Array.isArray(a.honoraires) ? a.honoraires : [];
      const pct = hSum(hon, "pct_du_prix", "pct");
      const montant = hSum(hon, "montant_eur_mwh", "eur_mwh");
      const plancherFee = hMax(hon, "plancher_fee_eur_mwh", "eur_mwh");
      const plancherPer = hMax(hon, "plancher_periodique_eur", "eur");
      const aboKwcAn = hSum(hon, "abonnement_eur_kwc_an", "eur_kwc_an");
      const fvr = hFind(hon, "frais_volume_ref");
      const decote = Number(a.decote_eur_mwh) || 0;
      const partage = (a.partage_producteur_pct ?? 100) / 100;
      const trait = a.traitement_negatif || "plafonne_0";
      const baseMode = a.prix_base;
      const fixe = Number(a.prix_fixe_eur_mwh) || 0;

      // grille temporelle selon le prix de base
      let grid = prep;
      if (baseMode === "epex") {
        if (!epex.length) { notes.push(`${a.nom} : prix EPEX absents en base — lancez le backfill EPEX.`); return null; }
        grid = epex;
      }

      const vente = new Array(13).fill(0);
      const feevar = new Array(13).fill(0);
      let volKwh = 0;

      for (const row of grid) {
        const i30 = idx30(row.start_date);
        const s30 = (i30 >= 0 && i30 < points.length) ? Number(points[i30]) || 0 : 0;
        const s15 = s30 / 2;
        let prixBase: number;
        if (baseMode === "prep" || baseMode === "epex") {
          if (row.prix_eur_mwh == null) continue;
          prixBase = Number(row.prix_eur_mwh);
        } else if (baseMode === "fixe") prixBase = fixe;
        else prixBase = 0;

        const m = monthParis(row.start_date);
        const prixNet = prixBase - decote;
        let valeur = s15 * prixNet / 1000;
        if (trait === "plafonne_0") valeur = Math.max(valeur, 0);
        let feeUnit = (pct / 100) * prixBase + montant;
        if (plancherFee != null) feeUnit = Math.max(feeUnit, plancherFee);

        vente[m] += valeur;
        feevar[m] += s15 * feeUnit / 1000;
        volKwh += s15;
      }

      const aboM = (aboKwcAn > 0 && kwc) ? kwc * aboKwcAn / 12 : 0;
      const months = [];
      let venteAn = 0, coutAn = 0;
      for (let m = 1; m <= 12; m++) {
        const feePer = plancherPer != null ? Math.max(feevar[m], plancherPer) : feevar[m];
        const coutHon = feePer + aboM;
        const venteM = vente[m];
        const net = (venteM < 0 && (trait === "impute_100" || trait === "reporte"))
          ? venteM - coutHon : partage * venteM - coutHon;
        const coutAgg = venteM - net;
        months.push({ mois: m, vente: r2(venteM), cout: r2(coutAgg) });
        venteAn += venteM; coutAn += coutAgg;
      }
      const volMwh = volKwh / 1000;
      const fraisVR = fvr ? Math.max(0, ((Number(fvr.params?.vref) || 0) - volMwh) * (Number(fvr.params?.taux) || 0)) : 0;
      coutAn += fraisVR;
      return {
        agregateur_id: a.id, nom: a.nom, prix_base: a.prix_base, months,
        annual: { vente: r2(venteAn), cout: r2(coutAn), net: r2(venteAn - coutAn), volume_mwh: r2(volMwh), frais_volume_ref: r2(fraisVR) },
      };
    }).filter(Boolean);

    return json({ courbe: { id: courbe.id, nom: courbe.nom, puissance_kwc: kwc }, results, notes });
  } catch (e) {
    return json({ error: "simulate_failed", detail: String((e as any)?.message ?? e) }, 500);
  }
});