// STAC · Genera una mini-página estática por producto en /p/<id>.html con las
// etiquetas Open Graph (imagen, nombre, precio) que WhatsApp/Facebook leen al
// compartir un link. La página redirige de inmediato al producto en la tienda.
//
// WhatsApp NO ejecuta JavaScript al armar la vista previa: por eso los links a
// la SPA (#p-...) solo mostraban el logo. Estas páginas sí traen los datos.
//
// Uso: node generar-paginas-compartir.js   (el robot diario lo corre solo)

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OUT = path.join(__dirname, '..', 'p');
const BASE = 'https://mikequeso.github.io/STAC';

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function descCorta(p) {
  let t = '';
  if (p.description_html) t = p.description_html.replace(/<[^>]+>/g, ' ');
  else if (p.description) t = p.description;
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) t = `${p.category || 'Producto'} disponible en STAC con asesoría experta.`;
  return t.slice(0, 160);
}

(async () => {
  const { data: products, error } = await sb.from('products')
    .select('id, name, category, price, images, description, description_html');
  if (error) { console.error(error.message); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });

  const vigentes = new Set();
  let escritas = 0;
  for (const p of products) {
    const img = (p.images && p.images[0]) ? p.images[0] : `${BASE}/icon-512.png`;
    const titulo = `${p.name} — $${Number(p.price).toLocaleString('es-MX')} MXN`;
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)} | STAC</title>
<meta name="description" content="${esc(descCorta(p))}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="STAC · Componentes para PC">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descCorta(p))}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${BASE}/p/${p.id}.html">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=../#p-${p.id}">
<link rel="icon" href="../favicon.png">
<script>location.replace('../#p-${p.id}');</script>
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px;">
<p>Abriendo producto en STAC… <a href="../#p-${p.id}">clic aquí si no redirige</a></p>
</body>
</html>`;
    fs.writeFileSync(path.join(OUT, `${p.id}.html`), html, 'utf8');
    vigentes.add(`${p.id}.html`);
    escritas++;
  }

  // borrar páginas de productos que ya no existen
  let borradas = 0;
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith('.html') && !vigentes.has(f)) { fs.unlinkSync(path.join(OUT, f)); borradas++; }
  }
  console.log(`Páginas de compartir: ${escritas} escritas, ${borradas} obsoletas borradas.`);
})();
