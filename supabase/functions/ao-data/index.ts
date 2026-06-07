import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { requireAuth, adminClient } from "../_shared/auth.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Valide + nettoie un tableau de points (kWh par pas) et renvoie le total
function sanitizePoints(points: unknown): { points: number[]; total: number } {
  if (!Array.isArray(points)) throw new Error("points doit être un tableau");
  const clean = points.map((v, i) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`valeur non numérique à l'index ${i}`);
    return n;
  });
  const total = clean.reduce((a, b) => a + b, 0);
  return { points: clean, total: Math.round(total * 1000) / 1000 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!(await requireAuth(req))) return json({ error: "unauthorized" }, 401);

  let payload: { action?: string; data?: any } = {};
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const db = adminClient();
  const { action, data } = payload;

  try {
    switch (action) {
      // ---------- COURBES ----------
      case "list_courbes": {
        const { data: rows, error } = await db
          .from("ao_courbes_charge")
          .select("id, created_at, nom, puissance_kwc, pas_minutes, total_kwh")
          .order("created_at", { ascending: false });
        if (error) throw error;
        return json({ courbes: rows });
      }
      case "get_courbe": {
        const { data: row, error } = await db
          .from("ao_courbes_charge").select("*").eq("id", data.id).single();
        if (error) throw error;
        return json({ courbe: row });
      }
      case "upsert_courbe": {
        const { points, total } = sanitizePoints(data.points);
        const row: any = {
          nom: String(data.nom ?? "Sans nom"),
          puissance_kwc: data.puissance_kwc != null ? Number(data.puissance_kwc) : null,
          pas_minutes: 30,
          total_kwh: total,
          points,
        };
        if (data.id) row.id = data.id; // update si id fourni, sinon insert
        const { data: saved, error } = await db
          .from("ao_courbes_charge").upsert(row).select("id, nom, total_kwh").single();
        if (error) throw error;
        return json({ courbe: saved });
      }
      case "delete_courbe": {
        const { error } = await db.from("ao_courbes_charge").delete().eq("id", data.id);
        if (error) throw error;
        return json({ ok: true });
      }
      case "update_courbe_meta": {
        const patch: any = {};
        if (data.nom !== undefined) patch.nom = String(data.nom);
        if (data.puissance_kwc !== undefined)
          patch.puissance_kwc = data.puissance_kwc === null ? null : Number(data.puissance_kwc);
        const { data: saved, error } = await db
          .from("ao_courbes_charge").update(patch).eq("id", data.id)
          .select("id, nom, puissance_kwc, total_kwh").single();
        if (error) throw error;
        return json({ courbe: saved });
      }

      // ---------- AGREGATEURS ----------
      case "list_agregateurs": {
        const { data: rows, error } = await db
          .from("ao_agregateurs").select("*").order("created_at", { ascending: false });
        if (error) throw error;
        return json({ agregateurs: rows });
      }
      case "upsert_agregateur": {
        const row: any = {
          nom: String(data.nom ?? "Sans nom"),
          prix_base: data.prix_base ?? "aucun",
          prix_fixe_eur_mwh: Number(data.prix_fixe_eur_mwh ?? 0),
          decote_eur_mwh: Number(data.decote_eur_mwh ?? 0),
          partage_producteur_pct: Number(data.partage_producteur_pct ?? 100),
          periodicite: data.periodicite ?? "mensuel",
          traitement_negatif: data.traitement_negatif ?? "ajoute_cout",
          honoraires: data.honoraires ?? [],
          notes: data.notes ?? null,
        };
        if (data.id) row.id = data.id;
        const { data: saved, error } = await db
          .from("ao_agregateurs").upsert(row).select("id, nom").single();
        if (error) throw error;
        return json({ agregateur: saved });
      }
      case "delete_agregateur": {
        const { error } = await db.from("ao_agregateurs").delete().eq("id", data.id);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: "unknown_action", action }, 400);
    }
  } catch (e) {
    return json({ error: "operation_failed", detail: String(e?.message ?? e) }, 400);
  }
});