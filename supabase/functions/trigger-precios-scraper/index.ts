// supabase/functions/trigger-precios-scraper/index.ts
//
// Permite al admin disparar manualmente, desde el Panel Admin, el workflow
// de GitHub Actions que revisa precios de proveedores (en vez de esperar a
// la corrida diaria de las 7am). Requiere sesión de un usuario con
// role = 'admin' en la tabla profiles.
//
// Variables de entorno (Secrets de la Edge Function en Supabase):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GITHUB_PAT  -> Personal Access Token con permiso "Actions: write" sobre
//                  el repo MikeQueso/STAC (fine-grained), usado solo para
//                  disparar el workflow_dispatch de precios-abasto.yml.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GITHUB_OWNER = "MikeQueso";
const GITHUB_REPO = "STAC";
const WORKFLOW_FILE = "precios-abasto.yml";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const githubPat = Deno.env.get("GITHUB_PAT");

    if (!supabaseUrl || !serviceKey) {
      return jsonResponse({ error: "Faltan variables de entorno en Supabase." }, 500);
    }
    if (!githubPat) {
      return jsonResponse({ error: "Falta configurar GITHUB_PAT en los secrets de la función." }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return jsonResponse({ error: "No autenticado." }, 401);
    }

    const sb = createClient(supabaseUrl, serviceKey);
    const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Sesión inválida." }, 401);
    }

    const { data: profile } = await sb.from("profiles").select("role").eq("id", userData.user.id).single();
    if (!profile || profile.role !== "admin") {
      return jsonResponse({ error: "Solo un administrador puede hacer esto." }, 403);
    }

    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${githubPat}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (!ghRes.ok) {
      const text = await ghRes.text().catch(() => "");
      console.error("[trigger-precios-scraper] GitHub respondió", ghRes.status, text);
      return jsonResponse({ error: `GitHub respondió con error (${ghRes.status}). Revisa que GITHUB_PAT tenga permiso de Actions sobre el repo.` }, 502);
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: msg }, 500);
  }
});
