// supabase/functions/ai-generate/index.ts
//
// Puente seguro entre el sitio STAC y la API de Google Gemini (capa gratuita).
// El navegador no puede llamar directamente (CORS) y la API key debe ocultarse,
// así que esta función vive en Supabase.
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
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Falta configurar GEMINI_API_KEY en Supabase." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { name, brand, category, price } = await req.json();

    const prompt = `Eres un experto en componentes de PC. Genera contenido de producto profesional para una tienda online en México.

Producto: ${name}
Marca: ${brand || "N/A"}
Categoría: ${category}
Precio: $${price} MXN

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta (sin markdown, sin bloques de código, sin texto adicional antes o después):
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

    // Modelo gratuito de Gemini
    const model = "gemini-2.5-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return new Response(
        JSON.stringify({ error: data.error?.message || "Error de la API de Gemini" }),
        { status: geminiRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
