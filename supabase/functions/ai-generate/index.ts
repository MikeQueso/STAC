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

    const prompt = `Eres un ingeniero de producto que redacta FICHAS TÉCNICAS EXHAUSTIVAS para una tienda de tecnología en México, al nivel de detalle de los catálogos mayoristas (Icecat / Cyberpuerta / Abasteo).

Producto: ${name}
Marca: ${brand || "N/A"}
Categoría: ${category}
Precio: $${price} MXN

Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin bloques de código, sin texto antes o después) con esta estructura exacta:
{
  "description": "Descripción corta de 1-2 líneas",
  "descriptionSections": [
    {"title": "Título de sección", "body": "Párrafo"}
  ],
  "specsGroups": [
    {
      "name": "Nombre del grupo",
      "features": [
        {"name": "Característica", "value": "Valor"}
      ]
    }
  ],
  "brandInfo": "Párrafo de 2-3 oraciones sobre la marca ${brand || ""}"
}

REGLAS PARA specsGroups (LO MÁS IMPORTANTE — debe ser MUY detallado):
- Genera una ficha extensa: entre 6 y 12 grupos y, en total, entre 30 y 70 características (pares nombre/valor), como las fichas de Icecat.
- Agrupa en secciones técnicas reales y relevantes al tipo de producto. Guía según categoría:
  • Procesador: Procesador, Rendimiento, Memoria compatible, Gráficos integrados, Control de energía, Características.
  • Tarjeta de video: Procesador gráfico, Memoria, Puertos e interfaces, Rendimiento, Diseño y enfriamiento, Control de energía, Peso y dimensiones.
  • Memoria RAM: Memoria, Rendimiento, Compatibilidad, Diseño.
  • Almacenamiento (SSD/HDD): Capacidad, Rendimiento, Interfaz, Confiabilidad, Diseño físico.
  • Placa madre: Socket y chipset, Memoria, Ranuras de expansión, Almacenamiento, Puertos traseros, Conectividad y red, Audio, Dimensiones.
  • Gabinete / Fuente de poder / Refrigeración / Mouse / Audífonos / Impresora / Tinta: usa las secciones equivalentes propias de ese producto.
- Usa SOLO datos técnicos reales y verificables del modelo EXACTO indicado. Si un dato no lo conoces con certeza, OMÍTELO (no inventes valores).
- Valores concretos y específicos (ej.: "Frecuencia base":"3.5 GHz", "Socket":"AM5", "Versión HDMI":"2.1b", "TDP":"170 W").

descriptionSections: mínimo 4 secciones (ej.: Rendimiento, Características, Conectividad, Casos de uso recomendados), cada una con un párrafo informativo.
description: 1-2 líneas.
brandInfo: 2-3 oraciones sobre ${brand || "la marca"}.`;

    // Modelo gratuito de Gemini
    const model = "gemini-2.0-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Un reintento corto ante 429 (límite de tasa). Si la cuota está agotada
    // (limit: 0), no tiene caso reintentar mucho: falla rápido.
    let geminiRes;
    let attempt = 0;
    const maxAttempts = 2;
    while (attempt < maxAttempts) {
      geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        }),
      });

      if (geminiRes.status !== 429) break;
      attempt++;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000));
    }

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
