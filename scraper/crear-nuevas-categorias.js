// Crea las categorías nuevas "Ventiladores" y "Computadoras ya armadas" con
// productos reales (precio + imagen + ficha) leídos de
// nuevas-categorias-candidatos.json.
try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildFicha: buildFichaBase, detectBrand } = require('./enriquecer-reemplazos.js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BUCKET = 'productos';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DRY = process.argv.includes('--dry');

// Mapea las claves del JSON (que separan gamer/empresarial solo para buscar)
// a la categoría real del producto y al prefijo de SKU.
const GRUPOS = {
  'Ventiladores': { categoria: 'Ventiladores', prefijo: 'VEN' },
  'Computadoras ya armadas — Gamer': { categoria: 'Computadoras ya armadas', prefijo: 'PCG' },
  'Computadoras ya armadas — Empresarial': { categoria: 'Computadoras ya armadas', prefijo: 'PCE' },
};

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

async function uploadImage(id, url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } }).catch(() => null);
  if (!res || !res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) return null;
  const ext = extFromType(ct, url);
  const path = `${id}/0.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType: ct || ('image/' + ext), upsert: true });
  if (up.error) return null;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

(async () => {
  const cand = JSON.parse(fs.readFileSync('nuevas-categorias-candidatos.json', 'utf8'));

  // Asegura que existan las categorías en la tabla `categories`.
  if (!DRY) {
    for (const nombre of ['Ventiladores', 'Computadoras ya armadas']) {
      const { error } = await sb.from('categories').insert({ name: nombre });
      if (error && !/duplicate/i.test(error.message)) console.log(`Aviso categoría "${nombre}":`, error.message);
    }
  }

  let creados = 0, fallos = 0;
  for (const [grupoKey, list] of Object.entries(cand)) {
    const grupo = GRUPOS[grupoKey];
    if (!grupo) { console.log(`⚠ grupo desconocido: ${grupoKey}`); continue; }
    let n = 1;
    for (const c of list) {
      const id = crypto.randomUUID();
      const brand = detectBrand(c.name);
      const ficha = buildFichaBase(grupo.categoria, c.name, null, c.name);

      if (DRY) { console.log(`[DRY] ${grupo.categoria}  ${c.name.slice(0, 60)}  $${c.price}`); creados++; continue; }

      const imgUrl = await uploadImage(id, c.image);
      if (!imgUrl) { console.log(`  ✘ sin imagen, salto: ${c.name.slice(0, 60)}`); fallos++; continue; }

      const row = {
        id, name: c.name, category: grupo.categoria, price: c.price, old_price: null,
        ref: `${grupo.prefijo}-${String(n).padStart(3, '0')}`, images: [imgUrl],
        brand, description: ficha.specsFlat, description_html: ficha.description_html,
        specs: ficha.specsFlat, specs_json: JSON.stringify(ficha.specsGroups), brand_info: brand,
        stock: 10,
      };
      const ins = await sb.from('products').insert(row);
      if (ins.error) { console.log(`  ✘ insert falló (${c.name.slice(0, 50)}): ${ins.error.message}`); fallos++; continue; }

      await sb.from('precios_abasto').insert({
        product_id: id, proveedor: c.proveedor, precio: c.price, url: c.url,
        encontrado_como: c.name, actualizado_at: new Date().toISOString(),
      });
      n++; creados++;
    }
  }

  console.log(`\nCreados: ${creados} | Fallos: ${fallos}`);
})();
