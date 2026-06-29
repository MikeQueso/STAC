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
  'Almacenamiento':    { needed: 12, src: 'dd', queries: ['ssd kingston', 'ssd crucial', 'ssd adata', 'disco duro', 'ssd nvme', 'unidad estado solido'], must: /ssd|disco duro|estado s[oó]lido|nvme/i, reject: /enclosure|carcasa|gabinete|adaptador|cable|docking|lector|memoria ram|disipador/i },
  'Audífonos':         { needed: 8,  src: 'dd', queries: ['audifonos gamer', 'diadema gamer', 'audifonos inalambricos'], must: /audifono|diadema|headset/i },
  'Fuente de Poder':   { needed: 6,  src: 'dd', queries: ['fuente de poder', 'fuente poder corsair', 'fuente poder thermaltake', 'fuente poder cooler master', 'fuente poder evga'], must: /fuente/i, reject: /gabinete|combo|kit/i },
  'Gabinete':          { needed: 9,  src: 'dd', queries: ['gabinete gamer', 'gabinete atx', 'gabinete mid tower'], must: /gabinete/i },
  'Memoria RAM':       { needed: 7,  src: 'dd', queries: ['memoria ram', 'memoria ram kingston', 'memoria ram corsair', 'memoria ram adata'], must: /memoria ram/i },
  'Mouse':             { needed: 2,  src: 'dd', queries: ['mouse gamer', 'mouse inalambrico gamer'], must: /mouse/i },
  'Placa Madre':       { needed: 6,  src: 'dd', queries: ['tarjeta madre', 'tarjeta madre asus', 'tarjeta madre gigabyte', 'tarjeta madre msi'], must: /tarjeta madre|motherboard|placa/i },
  'Procesador':        { needed: 2,  src: 'dd', queries: ['procesador ryzen', 'procesador intel'], must: /procesador|ryzen|core i/i },
  'Refrigeración':     { needed: 5,  src: 'dd', queries: ['disipador', 'enfriamiento liquido', 'cooler cpu'], must: /disipador|enfriamiento|refriger|aio/i, reject: /gabinete|pasta|soporte|combo/i },
  'Tarjeta Gráfica':   { needed: 1,  src: 'dd', queries: ['tarjeta de video', 'tarjeta de video rtx', 'tarjeta de video radeon'], must: /geforce|radeon|\brtx\b|\bgtx\b|rx\s?\d|intel arc/i, reject: /soporte|riser|cable|extensor|adaptador|base|cooler/i },
  'Impresoras':        { needed: 17, src: 'od', render: true, queries: ['impresora', 'impresora laser', 'impresora tinta continua', 'impresora multifuncional'], must: /impresora|multifuncional/i },
  'Tinta de impresora':{ needed: 11, src: 'od', queries: ['cartucho tinta hp', 'cartucho tinta canon', 'botella tinta epson', 'cartucho tinta brother', 'toner'], must: /tinta|cartucho|toner|tóner|botella/i },
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

(async () => {
  const { data: existing } = await sb.from('products').select('name');
  const existingCodes = new Set();
  for (const p of existing) for (const c of modelCodes(p.name)) existingCodes.add(c);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  const out = {};

  for (const [cat, cfg] of Object.entries(CONFIG)) {
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
                  : cfg.render ? await odRender(page, q)
                  : await odSearch(q);
      for (const it of items) raw.push(it);
    }

    for (const it of raw) {
      if (picked.length >= cfg.needed) break;
      const price = parsePrice(it.price);
      if (!price) continue;
      const title = it.title;
      if (!cfg.must.test(title.slice(0, 60))) continue;          // es de la categoria (al inicio)
      if (cfg.reject && cfg.reject.test(title)) continue;        // descarta accesorios/otra categoria
      if (/comput|laptop|combo|bundle|\bpc\b|barebone/i.test(title)) continue;
      const nm = norm(title);
      if (usedNames.has(nm)) continue;                           // no repetir el mismo modelo
      const codes = modelCodes(title);
      if (codes.some((c) => existingCodes.has(c) || usedCodes.has(c))) continue; // no duplicar
      if (usedUrls.has(it.url)) continue;
      let image = it.image || '';
      if (cfg.src === 'dd') image = await ddImage(page, it.url);
      if (!image) continue;                                       // exige imagen
      usedUrls.add(it.url);
      usedNames.add(nm);
      for (const c of codes) usedCodes.add(c);
      picked.push({ name: title, category: cat, price, image, url: it.url, proveedor: cfg.src === 'dd' ? 'DD Tech' : 'Office Depot' });
    }
    out[cat] = picked;
    console.log(`${cat}: ${picked.length}/${cfg.needed}`);
  }

  await browser.close();
  fs.writeFileSync('reemplazos-candidatos.json', JSON.stringify(out, null, 2), 'utf8');
  const total = Object.values(out).reduce((s, a) => s + a.length, 0);
  console.log(`\nTotal candidatos: ${total} (objetivo 86). Guardado en reemplazos-candidatos.json`);
})();
