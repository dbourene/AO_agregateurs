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

// Dernier dimanche du mois (month0: 0=janv) à 01:00 UTC — bornes DST UE
function lastSundayUtc(year: number, month0: number): number {
  const d = new Date(Date.UTC(year, month0 + 1, 0, 1, 0, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
// Offset Paris en minutes (sans Intl) : +60 (CET) ou +120 (CEST). Cache par année.
const _dst = new Map<number, { start: number; end: number }>();
function parisOffMin(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  let c = _dst.get(y);
  if (!c) { c = { start: lastSundayUtc(y, 2), end: lastSundayUtc(y, 9) }; _dst.set(y, c); }
  return (ms >= c.start && ms < c.end) ? 120 : 60;
}
// slot 30 min dans l'année + mois Paris, calculés une fois par créneau
function parisSlotMonth(iso: string): { i30: number; mois: number } {
  const ms = Date.parse(iso);
  const local = new Date(ms + parisOffMin(ms) * 60000);
  const mon = local.getUTCMonth() + 1;
  const doy = CUM[mon - 1] + (local.getUTCDate() - 1);
  const i30 = doy * 48 + local.getUTCHours() * 2 + (local.getUTCMinutes() >= 30 ? 1 : 0);
  return { i30, mois: mon };
}

// Année+mois courant en heure Paris
const PARIS_YM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit",
});

// Offset (minutes) dont Paris est en avance sur UTC à un instant donné
function parisOffsetMinutes(instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = dtf.formatToParts(instant);
  const g = (t: string) => +parts.find((x) => x.type === t)!.value;
  const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return (asUTC - instant.getTime()) / 60000;
}

// Heure murale Paris (y, mois0, jour, h, min) -> instant UTC ISO
function parisWallToUtcIso(y: number, m0: number, d: number, h = 0, min = 0): string {
  const guessMs = Date.UTC(y, m0, d, h, min);
  let off = parisOffsetMinutes(new Date(guessMs));
  let ms = guessMs - off * 60000;
  off = parisOffsetMinutes(new Date(ms)); // 2e passe : robuste près des bascules DST
  ms = guessMs - off * 60000;
  return new Date(ms).toISOString();
}

const hSum = (h: any[], t: string, f: string) => h.filter((x) => x.type === t).reduce((a, x) => a + (Number(x.params?.[f]) || 0), 0);
const hMax = (h: any[], t: string, f: string) => { const xs = h.filter((x) => x.type === t).map((x) => Number(x.params?.[f]) || 0); return xs.length ? Math.max(...xs) : null; };
const hFind = (h: any[], t: string) => h.find((x) => x.type === t);

async function fetchMarket(db: any, source: string, startIso: string, endIso: string) {
  const out: any[] = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await db.from("ao_prix_marche")
      .select("start_date,prix_eur_mwh").eq("source", source)
      .gte("start_date", startIso).lt("start_date", endIso)
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
    // --- Fenêtre dynamique : 12 mois calendaires révolus, mois courant exclu (Paris) ---
    const ym = PARIS_YM.formatToParts(new Date());
    const curY = +ym.find((x) => x.type === "year")!.value;
    const curM = +ym.find((x) => x.type === "month")!.value; // 1..12
    const startIso = parisWallToUtcIso(curY - 1, curM - 1, 1); // 1er du mois, il y a 12 mois
    const endIso = parisWallToUtcIso(curY, curM - 1, 1);       // 1er du mois courant (exclu)
    const { data: courbe, error: e1 } = await db.from("ao_courbes_charge").select("*").eq("id", body.courbe_id).single();
    if (e1) throw e1;
    const { data: aggs, error: e2 } = await db.from("ao_agregateurs").select("*").in("id", body.agregateur_ids);
    if (e2) throw e2;

    const prep = await fetchMarket(db, "prep", startIso, endIso);
    let epex: any[] = [];
    const needEpex = aggs.some((a: any) => a.prix_base === "epex");
    if (needEpex) epex = await fetchMarket(db, "epex", startIso, endIso);

    // Pré-calcul des indices temporels UNE fois par créneau (et non par agrégateur)
    for (const r of prep) { const f = parisSlotMonth(r.start_date); r.i30 = f.i30; r.mois = f.mois; }
    for (const r of epex) { const f = parisSlotMonth(r.start_date); r.i30 = f.i30; r.mois = f.mois; }

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
      const fraisFixeAn = hSum(hon, "frais_fixe_eur_an", "eur_an");
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
        const i30 = row.i30;
        const s30 = (i30 >= 0 && i30 < points.length) ? Number(points[i30]) || 0 : 0;
        const s15 = s30 / 2;
        let prixBase: number;
        if (baseMode === "prep" || baseMode === "epex") {
          if (row.prix_eur_mwh == null) continue;
          prixBase = Number(row.prix_eur_mwh);
        } else if (baseMode === "fixe") prixBase = fixe;
        else prixBase = 0;

        const m = row.mois;
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
      coutAn += fraisVR + fraisFixeAn;
      return {
        agregateur_id: a.id, nom: a.nom, prix_base: a.prix_base, months,
        annual: {
          vente: r2(venteAn), cout: r2(coutAn), net: r2(venteAn - coutAn), volume_mwh: r2(volMwh),
          frais_volume_ref: r2(fraisVR), frais_fixe_annuel: r2(fraisFixeAn),
        },
      };
    }).filter(Boolean);

    return json({
      courbe: { id: courbe.id, nom: courbe.nom, puissance_kwc: kwc },
      periode: { start: startIso, end: endIso, mois_debut: curM, mois_fin: curM === 1 ? 12 : curM - 1 },
      results, notes,
    });
  } catch (e) {
    return json({ error: "simulate_failed", detail: String((e as any)?.message ?? e) }, 500);
  }
});