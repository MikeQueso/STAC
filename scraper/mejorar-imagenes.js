// STAC · Mejora las imágenes de los productos: visita la página del producto
// en Abasteo o DD Tech (la URL que ya encontró el robot de precios), descarga
// TODAS las vistas de la galería en alta resolución y las sube a Storage,
// actualizando products.images con varias vistas.
//
// Uso:
//   node mejorar-imagenes.js                     -> todos los productos con página
//   node mejorar-imagenes.js --cat="Computadoras ya armadas"
//   node mejorar-imagenes.js --dry               -> solo muestra qué haría
//
// Reglas:
//   - "Computadoras ya armadas": siempre reemplaza (sus imágenes actuales son borrosas).
//   - Demás categorías: solo si el producto tiene 0-1 imágenes y encontramos 2+.

try { require('dotenv').config(); } catch (e) {}
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BUCKET = 'productos';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DRY = process.argv.includes('--dry');
const CAT_ARG = (process.argv.find((a) => a.startsWith('--cat=')) || '').replace('--cat=', '');
const MAX_IMGS = 5;

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// Galería de una página de producto de Abasteo (OXID, mismas rutas que
// Cyberpuerta). Las miniaturas usan /generated/product/N/ANCHOxALTO_75/x.jpg;
// la versión master (máxima resolución) vive en /master/product/N/x.jpg.
async function abasteoGallery(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(800);
  const srcs = await page.$$eval('img', (imgs) =>
    imgs.map((i) => i.src || i.getAttribute('data-src') || '').filter(Boolean)
  ).catch(() => []);
  const out = [];
  const seen = new Set();
  for (const s of srcs) {
    if (!/\/out\/pictures\//.test(s) || /blank\.gif|logo/i.test(s)) continue;
    const file = s.split('/').pop();
    if (seen.has(file)) continue;
    seen.add(file);
    // miniatura generada -> master en alta resolución; si master no existe,
    // uploadImage recibirá ambas y usará la original como respaldo
    const master = s.replace(/\/generated\/product\/(\d+)\/[0-9_x]+\//, '/master/product/$1/');
    out.push(master === s ? { url: s } : { url: master, fallback: s });
  }
  return out.slice(0, MAX_IMGS);
}

// Galería de una página de producto de DD Tech (imágenes en assets/uploads).
async function ddtechGallery(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(800);
  const srcs = await page.$$eval('img', (imgs) =>
    imgs.map((i) => i.src || i.getAttribute('data-src') || '').filter(Boolean)
  ).catch(() => []);
  const og = await page.evaluate(() =>
    document.querySelector('meta[property="og:image"]')?.content || ''
  ).catch(() => '');
  const out = [];
  const seen = new Set();
  for (const s of [og, ...srcs]) {
    if (!/assets\/uploads/.test(s) || /blank\.gif/.test(s)) continue;
    const file = s.split('/').pop();
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({ url: s });
  }
  return out.slice(0, MAX_IMGS);
}

async function fetchImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } }).catch(() => null);
  if (!res || !res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!/image/.test(ct)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) return null; // descarta iconos/miniaturas rotas
  return { buf, ct };
}

async function uploadImage(productId, n, item) {
  let img = await fetchImage(item.url);
  let usedUrl = item.url;
  if (!img && item.fallback) { img = await fetchImage(item.fallback); usedUrl = item.fallback; }
  if (!img) return null;
  const ext = extFromType(img.ct, usedUrl);
  const path = `${productId}/${n}.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, img.buf, { contentType: img.ct || ('image/' + ext), upsert: true });
  if (up.error) return null;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

(async () => {
  const { data: products, error } = await sb.from('products').select('id, name, category, images');
  if (error) { console.error(error.message); process.exit(1); }

  const { data: precios } = await sb.from('precios_abasto')
    .select('product_id, proveedor, url, encontrado_como')
    .not('encontrado_como', 'is', null);

  // Página preferida por producto: Abasteo (imágenes grandes) > DD Tech.
  const paginaDe = {};
  for (const r of precios || []) {
    if (!r.url || !/abasteo\.mx|ddtech\.mx/.test(r.url)) continue;
    const cur = paginaDe[r.product_id];
    if (!cur || (r.proveedor === 'Abasteo' && cur.proveedor !== 'Abasteo')) paginaDe[r.product_id] = r;
  }

  const targets = products.filter((p) => {
    if (CAT_ARG && p.category !== CAT_ARG) return false;
    if (!paginaDe[p.id]) return false;
    if (p.category === 'Computadoras ya armadas') return true; // siempre: borrosas
    return (p.images || []).length <= 1;                        // demás: solo una vista
  });
  console.log(`Productos a procesar: ${targets.length}`);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  let mejorados = 0, sinCambio = 0, fallos = 0;

  for (const p of targets) {
    const ref = paginaDe[p.id];
    try {
      const gallery = ref.proveedor === 'Abasteo'
        ? await abasteoGallery(page, ref.url)
        : await ddtechGallery(page, ref.url);

      const esCompu = p.category === 'Computadoras ya armadas';
      // Para no empeorar: solo reemplazar si conseguimos 2+ vistas,
      // o 1 vista tratándose de computadoras (su imagen actual es mala).
      if (gallery.length < 2 && !(esCompu && gallery.length >= 1)) {
        sinCambio++;
        console.log(`  = ${p.name.slice(0, 60)} (galería: ${gallery.length})`);
        continue;
      }
      if (DRY) {
        mejorados++;
        console.log(`[DRY] ${p.name.slice(0, 60)} -> ${gallery.length} vistas (${ref.proveedor})`);
        continue;
      }

      const urls = [];
      for (let i = 0; i < gallery.length; i++) {
        const u = await uploadImage(p.id, i, gallery[i]);
        if (u) urls.push(u + `?v=${Date.now()}`); // cache-bust: reemplaza la vieja
      }
      if (!urls.length || (urls.length < 2 && !esCompu)) {
        sinCambio++;
        console.log(`  = ${p.name.slice(0, 60)} (descargadas: ${urls.length})`);
        continue;
      }
      const { error: upErr } = await sb.from('products').update({ images: urls }).eq('id', p.id);
      if (upErr) { fallos++; console.error(`  ✘ ${p.name.slice(0, 50)}: ${upErr.message}`); continue; }
      mejorados++;
      console.log(`  ✔ ${p.name.slice(0, 60)} -> ${urls.length} vistas (${ref.proveedor})`);
    } catch (e) {
      fallos++;
      console.error(`  ✘ ${p.name.slice(0, 50)}: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\nMejorados: ${mejorados} | Sin cambio: ${sinCambio} | Fallos: ${fallos}`);
})();
