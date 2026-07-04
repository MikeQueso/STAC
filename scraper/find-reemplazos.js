// Busca productos reales CON precio + imagen, por categoria, para reemplazar
// los que quedaron sin precio. Salida: reemplazos-candidatos.json
try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!m) return null;
  const nums = m.map((x) => parseFloat(x.replace(/,/g, ''))).filter((n) => n > 0);
  return nums.length ? Math.min(...nums) : null;
}
// Codigos de modelo DISTINTIVOS (numeros de parte) para deduplicar. Excluye
// tokens genericos de especificacion (ddr4, 16gb, 3200mhz, b550…) que comparten
// muchos productos distintos y causarian falsos duplicados.
function modelCodes(name) {
  return (name.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => {
    if (!/\d/.test(t) || !/[a-z]/.test(t)) return false;
    if (/^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm|bit|v|ppm|dpi)$/.test(t)) return false; // especificacion
    if (/^\d+x\d+$/.test(t)) return false;
    if (/^ddr\d$/.test(t) || /^cl\d+$/.test(t) || /^pcie?\d?$/.test(t)) return false;
    if (/^[a-z]\d{3}$/.test(t)) return false; // familia de chipset: b550, b760, x670…
    return t.length >= 5; // numeros de parte reales: rm850x, mx500, sn580, 5600x…
  });
}

// needed = cuantos faltan por categoria; src = de donde sacarlos; queries = busquedas.
const CONFIG = {
  // Segunda pasada 04-jul-2026: solo faltan 1 audífono, 1 gabinete y 2 ventiladores.
  'Almacenamiento':    { needed: 0, src: 'dd', queries: ['ssd kingston', 'ssd crucial', 'ssd adata', 'disco duro', 'ssd nvme', 'unidad estado solido'], must: /ssd|disco duro|estado s[oó]lido|nvme/i, reject: /enclosure|carcasa|gabinete|adaptador|cable|docking|lector|memoria ram|disipador/i },
  'Audífonos':         { needed: 1, src: 'dd', queries: ['diadema hyperx', 'audifonos logitech gamer', 'diadema razer', 'audifonos gamer', 'diadema gamer'], must: /audifono|diadema|headset/i },
  'Fuente de Poder':   { needed: 0, src: 'dd', queries: ['fuente de poder', 'fuente poder corsair', 'fuente poder thermaltake', 'fuente poder cooler master', 'fuente poder evga'], must: /fuente/i, reject: /gabinete|combo|kit/i },
  'Gabinete':          { needed: 1, src: 'dd', queries: ['gabinete lian li', 'gabinete nzxt', 'gabinete cooler master', 'gabinete gamer', 'gabinete atx'], must: /gabinete/i },
  'Memoria RAM':       { needed: 0, src: 'dd', queries: ['memoria ram', 'memoria ram kingston', 'memoria ram corsair', 'memoria ram adata'], must: /memoria ram/i },
  'Placa Madre':       { needed: 0, src: 'dd', queries: ['tarjeta madre', 'tarjeta madre asus', 'tarjeta madre gigabyte', 'tarjeta madre msi'], must: /tarjeta madre|motherboard|placa/i },
  'Procesador':        { needed: 0, src: 'dd', queries: ['procesador ryzen', 'procesador intel'], must: /procesador|ryzen|core i/i },
  'Ventiladores':      { needed: 2, src: 'dd', queries: ['ventilador corsair', 'ventilador thermaltake', 'ventilador cooler master', 'kit ventiladores argb', 'ventilador gabinete', 'ventilador gabinete argb'], must: /ventilador/i, reject: /disipador|enfriamiento liquido|aio|laptop|base|soporte|cpu/i },
  // A diferencia de las demas categorias, aqui SI queremos resultados tipo
  // "Computadora ..." (ver allowBuild abajo, que desactiva el filtro global
  // que excluye comput/pc/combo para las demas categorias).
  // Las gamer de DD Tech casi todas traen GPU dedicada y superan $15,000;
  // Abasteo tiene equipos de oficina/basicos sin GPU dedicada, mas baratos.
  'Computadoras ya armadas': { needed: 0, src: 'ab', allowBuild: true, maxPrice: 15000, queries: ['computadora', 'computadora de escritorio', 'pc de escritorio', 'computadora oficina'], must: /computadora|\bpc\b/i, reject: /laptop|notebook|barebone|gabinete\s*$/i },
};

async function ddSearch(page, q) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(q).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.product h3.name'), { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(600);
  return await page.$$eval('.product', (nodes) => nodes.slice(0, 16).map((n) => ({
    title: (n.querySelector('h3.name, .name')?.textContent || '').trim(),
    price: (n.querySelector('.price, .product-price')?.textContent || '').trim(),
    url: n.querySelector('a[href*="/producto/"]')?.href || '',
  })).filter((x) => x.title && x.url)).catch(() => []);
}

// ─── ABASTEO (misma plataforma OXID que Cyberpuerta, precios publicos) ──
async function abSearch(page, q) {
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-product-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  return await page.$$eval('.c-product-card', (nodes) => nodes.slice(0, 16).map((n) => ({
    title: (n.querySelector('.c-product-pic__product-img')?.getAttribute('alt') || '').trim(),
    price: (n.querySelector('.c-product-price__price')?.textContent || '').trim(),
    image: n.querySelector('.c-product-pic__product-img')?.getAttribute('src') || '',
    url: n.querySelector('.c-product-pic__link')?.href || '',
  })).filter((x) => x.title && x.url)).catch(() => []);
}

async function ddImage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]')?.content;
      if (og && !/blank\.gif/.test(og)) return og;
      const im = [...document.querySelectorAll('img')].map((i) => i.src)
        .find((s) => /assets\/uploads/.test(s) && !/blank\.gif/.test(s));
      return im || '';
    });
  } catch { return ''; }
}

// OD renderizado: los resultados reales cargan por JS; renderizamos y leemos
// las tarjetas (nombre, precio, imagen con su token, url). Necesario p.ej. para
// impresoras, donde el HTML solo trae 4 destacados.
async function odRender(page, q) {
  const url = `https://www.officedepot.com.mx/search?text=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, 3000)); await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, 6000)); await page.waitForTimeout(2000);
  return await page.evaluate(() => {
    const res = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/p/"]')) {
      const card = a.closest('li,div'); if (!card) continue;
      const href = a.href.split('?')[0]; if (seen.has(href)) continue;
      const img = card.querySelector('img');
      let src = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
      if (!/medias/.test(src)) continue;                         // imagen real, no placeholder
      if (src.startsWith('/')) src = location.origin + src;      // absolutiza URL relativa
      const txt = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const name = (txt.replace(/^SKU:\s*\d+\s*/, '').split('$')[0] || '').trim();
      const prices = (txt.match(/\$[\d,]+(?:\.\d+)?/g) || []).map((x) => parseFloat(x.replace(/[$,]/g, '')));
      if (!name || !prices.length) continue;
      seen.add(href);
      res.push({ title: name, price: String(Math.min(...prices)), image: src, url: href });
    }
    return res;
  }).catch(() => []);
}

async function odSearch(q) {
  const url = `https://www.officedepot.com.mx/search?text=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' } }).catch(() => null);
  if (!res || !res.ok) return [];
  const html = await res.text();
  const items = [];
  for (const blk of html.split('"@type": "Product"').slice(1)) {
    const b = blk.slice(0, 1700);
    const n = b.match(/"name":\s*"([^"]+)"/);
    const p = b.match(/"price":\s*"?([0-9.]+)"?/);
    const img = b.match(/"image":\s*"([^"]+)"/);
    const u = b.match(/"url":\s*"([^"]+)"/);
    if (n && p) items.push({
      title: n[1], price: p[1],
      image: img ? img[1].replace(':443', '') : '',
      url: u ? u[1].replace(':443', '') : '',
    });
  }
  return items;
}

const CAT_ARG    = (process.argv.find((a) => a.startsWith('--cat='))    || '').replace('--cat=', '');
const NEEDED_ARG = (process.argv.find((a) => a.startsWith('--needed=')) || '').replace('--needed=', '');

(async () => {
  const { data: existing } = await sb.from('products').select('name');
  const existingCodes = new Set();
  const existingNames = new Set();
  for (const p of existing) {
    for (const c of modelCodes(p.name)) existingCodes.add(c);
    existingNames.add(p.name.split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, ''));
  }

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  const out = {};

  for (const [cat, cfg] of Object.entries(CONFIG)) {
    if (CAT_ARG && cat !== CAT_ARG) continue;
    if (NEEDED_ARG) cfg.needed = parseInt(NEEDED_ARG, 10);
    const picked = [];
    const usedCodes = new Set();
    const usedUrls = new Set();
    const usedNames = new Set();
    const norm = (s) => s.split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

    // Reune candidatos crudos de todas las queries de la categoria.
    const raw = [];
    for (const q of cfg.queries) {
      if (picked.length >= cfg.needed * 3) break;
      const items = cfg.src === 'dd' ? await ddSearch(page, q)
                  : cfg.src === 'ab' ? await abSearch(page, q)
                  : cfg.render ? await odRender(page, q)
                  : await odSearch(q);
      for (const it of items) raw.push(it);
    }

    for (const it of raw) {
      if (picked.length >= cfg.needed) break;
      const price = parsePrice(it.price);
      if (!price) continue;
      if (cfg.maxPrice && price > cfg.maxPrice) continue;
      const title = it.title;
      if (!cfg.must.test(title.slice(0, 60))) continue;          // es de la categoria (al inicio)
      if (cfg.reject && cfg.reject.test(title)) continue;        // descarta accesorios/otra categoria
      if (!cfg.allowBuild && /comput|laptop|combo|bundle|\bpc\b|barebone/i.test(title)) continue;
      const nm = norm(title);
      if (usedNames.has(nm) || existingNames.has(nm)) continue;  // no repetir el mismo modelo
      const codes = modelCodes(title);
      if (codes.some((c) => existingCodes.has(c) || usedCodes.has(c))) continue; // no duplicar
      if (usedUrls.has(it.url)) continue;
      let image = it.image || '';
      if (cfg.src === 'dd') image = await ddImage(page, it.url);
      if (!image) continue;                                       // exige imagen
      usedUrls.add(it.url);
      usedNames.add(nm);
      for (const c of codes) usedCodes.add(c);
      const proveedor = cfg.src === 'dd' ? 'DD Tech' : cfg.src === 'ab' ? 'Abasteo' : 'Office Depot';
      picked.push({ name: title, category: cat, price, image, url: it.url, proveedor });
    }
    out[cat] = picked;
    console.log(`${cat}: ${picked.length}/${cfg.needed}`);
  }

  await browser.close();
  fs.writeFileSync('reemplazos-candidatos.json', JSON.stringify(out, null, 2), 'utf8');
  const total = Object.values(out).reduce((s, a) => s + a.length, 0);
  console.log(`\nTotal candidatos: ${total} (objetivo 86). Guardado en reemplazos-candidatos.json`);
})();
