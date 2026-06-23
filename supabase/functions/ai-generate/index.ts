// supabase/functions/ai-generate/index.ts
//
// Puente seguro entre el sitio STAC y la API de Anthropic (Claude).
// El navegador no puede llamar a la API de Claude directamente (CORS),
// así que esta función vive en Supabase y oculta la API key.
//
// Uso desde el sitio (POST):
//   body: { name, brand, category, price }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en Supabase." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { name, brand, category, price } = await req.json();

    const prompt = `Eres un experto en componentes de PC. Genera contenido de producto profesional para una tienda online en México.

Producto: ${name}
Marca: ${brand || "N/A"}
Categoría: ${category}
Precio: $${price} MXN

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta (sin markdown, sin bloques de código):
{
  "description": "Descripción corta de 1-2 líneas",
  "descriptionSections": [
    {"title": "Título de sección", "body": "Párrafo del contenido"},
    {"title": "Título de sección 2", "body": "Párrafo 2"},
    {"title": "Casos de uso recomendados", "body": "Párrafo 3"}
  ],
  "specsGroups": [
    {
      "name": "Nombre del grupo (ej: Procesador, Memoria, Conectividad)",
      "features": [
        {"name": "Característica", "value": "Valor"},
        {"name": "Característica 2", "value": "Valor 2"}
      ]
    }
  ],
  "brandInfo": "Párrafo de 2-3 oraciones sobre la marca ${brand || ""} y su posición en el mercado de componentes de PC"
}

Incluye mínimo 3 secciones de descripción y mínimo 2 grupos de specs con al menos 4 características cada uno. Usa datos técnicos reales y precisos del producto.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return new Response(
        JSON.stringify({ error: data.error?.message || "Error de la API de Anthropic" }),
        { status: anthropicRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const text = (data.content?.[0]?.text || "").trim();
    return new Response(
      JSON.stringify({ text }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
