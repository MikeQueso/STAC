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
// --redo-abasteo: reprocesa TODOS los productos con página de Abasteo aunque ya
// tengan varias imágenes (para limpiar los sellos ISO que se colaron).
const REDO_AB = process.argv.includes('--redo-abasteo');
// --redo-ddtech: ídem para productos cuya página preferida es DD Tech (para
// limpiar los banners del sidebar que se colaron como "vistas").
const REDO_DD = process.argv.includes('--redo-ddtech');
// --solo="regex": limita a productos cuyo nombre coincida (reintentos puntuales).
const SOLO = (process.argv.find((a) => a.startsWith('--solo=')) || '').replace('--solo=', '');
const MAX_IMGS = 5;

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// Galería de una página de producto de Abasteo. Las fotos REALES del producto
// viven en cyberpuerta.mx/img/product/{S|M|XL}/CODIGO-hash.ext:
//   - imagen principal: clase .c-pdp-left__main-picture (tamaño M)
//   - vistas del carrusel: clase .cpx-square-img__img (tamaño S)
// OJO: NO tomar imágenes sueltas de /out/pictures/ (sellos ISO9001, GPTW,
// paquetería) ni .cpx-product-image__img (son productos RELACIONADOS).
async function abasteoGallery(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-pdp-left__main-picture', { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const data = await page.evaluate(() => ({
    main: document.querySelector('.c-pdp-left__main-picture')?.src || '',
    thumbs: [...document.querySelectorAll('.cpx-square-img__img')].map((i) => i.src).filter(Boolean),
  })).catch(() => ({ main: '', thumbs: [] }));

  // Código de producto del nombre de archivo (CP-MARCA-MODELO-hash.jpg →
  // CP-MARCA-MODELO). Las vistas del MISMO producto comparten código; las
  // imágenes promocionales del carrusel traen códigos distintos.
  const codeOf = (src) => {
    const f = (src.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
    const parts = f.split('-');
    if (parts.length > 1) parts.pop();
    return parts.join('-');
  };
  const mainCode = data.main ? codeOf(data.main) : '';

  const out = [];
  const seen = new Set();
  const push = (src, esPrincipal) => {
    if (!src || !/\/img\/product\//.test(src)) return;
    if (!esPrincipal && mainCode && codeOf(src) !== mainCode) return; // otra cosa, no este producto
    const file = src.split('/').pop();
    if (seen.has(file)) return;
    seen.add(file);
    // probar en orden: XL (máxima), L, M y por último la URL original
    const sizes = ['XL', 'L', 'M'].map((sz) => src.replace(/\/img\/product\/[A-Z]+\//, `/img/product/${sz}/`));
    out.push({ urls: [...new Set([...sizes, src])] });
  };
  push(data.main, true);
  for (const t of data.thumbs) push(t, false);
  return out.slice(0, MAX_IMGS);
}

// Galería de una página de producto de DD Tech: SOLO el carrusel del producto
// (.single-product-gallery-item). El resto de assets/uploads en la página son
// banners promocionales del sitio (sidebar-widget) y productos relacionados.
async function ddtechGallery(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.single-product-gallery-item img', { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => ({
    og: document.querySelector('meta[property="og:image"]')?.content || '',
    gallery: [...document.querySelectorAll('.single-product-gallery-item img')]
      .map((i) => i.src || i.getAttribute('data-src') || '').filter(Boolean),
  })).catch(() => ({ og: '', gallery: [] }));
  const out = [];
  const seen = new Set();
  for (const s of [...data.gallery, data.og]) {
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
  if (/svg/.test(ct)) return null; // los SVG son logos de plantilla, nunca fotos de producto
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) return null; // descarta iconos/miniaturas rotas
  return { buf, ct };
}

async function uploadImage(productId, n, item) {
  const tries = item.urls || [item.url, item.fallback].filter(Boolean);
  let img = null, usedUrl = '';
  for (const u of tries) {
    img = await fetchImage(u);
    if (img) { usedUrl = u; break; }
  }
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
    if (SOLO && !new RegExp(SOLO, 'i').test(p.name)) return false;
    if (!paginaDe[p.id]) return false;
    if (REDO_AB) return paginaDe[p.id].proveedor === 'Abasteo';  // limpieza de sellos ISO
    if (REDO_DD) return paginaDe[p.id].proveedor === 'DD Tech';  // limpieza de banners
    if (p.category === 'Computadoras ya armadas') return true;   // siempre: borrosas
    return (p.images || []).length <= 1;                          // demás: solo una vista
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

      // En modo redo o computadoras basta 1 vista (la actual es mala o trae sellos ISO);
      // en el resto solo reemplazar si conseguimos 2+ para no empeorar.
      const aceptaUna = p.category === 'Computadoras ya armadas' || REDO_AB || REDO_DD;
      const esCompu = aceptaUna;
      if (gallery.length < 2 && !(aceptaUna && gallery.length >= 1)) {
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
