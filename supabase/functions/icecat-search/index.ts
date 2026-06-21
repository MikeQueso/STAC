// supabase/functions/icecat-search/index.ts
//
// Puente entre el sitio STAC y la API de Icecat.
// Icecat exige que las llamadas con Api-Token sean servidor-a-servidor,
// así que esta función vive en Supabase y oculta el token del público.
//
// Uso desde el sitio (ejemplos):
//   .../icecat-search?prod_id=7600X&vendor=AMD&lang=ES
//   .../icecat-search?ean_upc=4710483xxxxxxx&lang=ES

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Preflight de CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const prodId = url.searchParams.get("prod_id");
    const vendor = url.searchParams.get("vendor");
    const ean = url.searchParams.get("ean_upc");
    const lang = url.searchParams.get("lang") || "ES";
    const imageUrl = url.searchParams.get("image_url");

    // Modo proxy de imagen: descarga la imagen del lado del servidor y la regresa
    // (evita problemas de CORS al subirla después a Supabase Storage)
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        return new Response(
          JSON.stringify({ error: `No se pudo descargar la imagen (status ${imgRes.status})` }),
          { status: imgRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const contentType = imgRes.headers.get("content-type") || "image/jpeg";
      const buffer = await imgRes.arrayBuffer();
      return new Response(buffer, {
        headers: { ...corsHeaders, "Content-Type": contentType },
      });
    }

    const token = Deno.env.get("ICECAT_API_TOKEN");
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Falta configurar el secreto ICECAT_API_TOKEN en Supabase." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let icecatUrl: string;
    if (ean) {
      icecatUrl = `https://data.icecat.biz/xml_s3/xml_server3.cgi?ean_upc=${encodeURIComponent(ean)}&lang=${encodeURIComponent(lang)}&output=productxml`;
    } else if (prodId && vendor) {
      icecatUrl = `https://data.icecat.biz/xml_s3/xml_server3.cgi?lang=${encodeURIComponent(lang)}&prod_id=${encodeURIComponent(prodId)}&vendor=${encodeURIComponent(vendor)}&output=productxml`;
    } else {
      return new Response(
        JSON.stringify({ error: "Falta prod_id+vendor, o ean_upc." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const icecatRes = await fetch(icecatUrl, {
      headers: { "Api-Token": token },
    });
    const xmlText = await icecatRes.text();

    return new Response(xmlText, {
      status: icecatRes.status,
      headers: { ...corsHeaders, "Content-Type": "application/xml" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
