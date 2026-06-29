// Busca candidatos reales (con precio + imagen) para 3 categorías nuevas:
// Ventiladores, y Computadoras ya armadas (gamer + empresarial).
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
function modelCodes(name) {
  return (name.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => {
    if (!/\d/.test(t) || !/[a-z]/.test(t)) return false;
    if (/^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm|bit|v)$/.test(t)) return false;
    if (/^\d+x\d+$/.test(t)) return false;
    return t.length >= 4;
  });
}

async function ddSearch(page, q) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(q).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.product h3.name'), { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(700);
  return await page.$$eval('.product', (nodes) => nodes.slice(0, 16).map((n) => ({
    title: (n.querySelector('h3.name, .name')?.textContent || '').trim(),
    price: (n.querySelector('.price, .product-price')?.textContent || '').trim(),
    url: n.querySelector('a[href*="/producto/"]')?.href || '',
  })).filter((x) => x.title)).catch(() => []);
}
async function ddImage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    return await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]')?.content;
      if (og && !/blank\.gif/.test(og)) return og;
      const im = [...document.querySelectorAll('img')].map((i) => i.src).find((s) => /assets\/uploads/.test(s) && !/blank\.gif/.test(s));
      return im || '';
    });
  } catch { return ''; }
}
async function abasteoSearch(page, q) {
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-product-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  return await page.$$eval('.c-product-card', (nodes) => nodes.slice(0, 16).map((n) => {
    const img = n.querySelector('.c-product-pic__product-img');
    return {
      title: (img?.getAttribute('alt') || '').trim(),
      image: img?.getAttribute('src') || '',
      price: (n.querySelector('.c-product-price__price')?.textContent || '').trim(),
      url: n.querySelector('.c-product-pic__link')?.href || '',
    };
  }));
}

const SKIP_VENTILADORES = false;
const CONFIG = {};
if (!SKIP_VENTILADORES) CONFIG['Ventiladores'] = {
  needed: 18, src: 'dd',
  // El "must" exige que el título EMPIECE con "Ventilador" para no colar
  // gabinetes que solo mencionan "incluye ventiladores" más adelante.
  queries: ['ventilador para gabinete', 'ventilador gamer 120mm', 'ventilador argb', 'ventilador 140mm', 'ventilador rgb pc', 'kit ventiladores gabinete'],
  must: /^ventilador/i, reject: /líquid|liquid|aio|disipador|hub/i,
  maxPrice: null,
};
const SKIP_PCS = true; // gamer y empresarial ya quedaron en 10/10, no repetir

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
    const norm = (s) => s.split(',')[0].split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

    const raw = [];
    for (const q of cfg.queries) {
      if (picked.length >= cfg.needed * 2.5) break;
      const items = cfg.src === 'dd' ? await ddSearch(page, q) : await abasteoSearch(page, q);
      for (const it of items) raw.push(it);
    }

    for (const it of raw) {
      if (picked.length >= cfg.needed) break;
      const price = parsePrice(it.price);
      if (!price) continue;
      if (cfg.maxPrice && price > cfg.maxPrice) continue;
      const title = it.title;
      if (!cfg.must.test(title)) continue;
      if (cfg.reject && cfg.reject.test(title)) continue;
      const nm = norm(title);
      if (usedNames.has(nm)) continue;
      const codes = modelCodes(title);
      if (codes.some((c) => existingCodes.has(c) || usedCodes.has(c))) continue;
      if (usedUrls.has(it.url)) continue;
      let image = it.image || '';
      if (cfg.src === 'dd') image = await ddImage(page, it.url);
      if (!image) continue;
      usedUrls.add(it.url);
      usedNames.add(nm);
      for (const c of codes) usedCodes.add(c);
      picked.push({ name: title, price, image, url: it.url, proveedor: cfg.src === 'dd' ? 'DD Tech' : 'Abasteo' });
    }
    out[cat] = picked;
    console.log(`${cat}: ${picked.length}/${cfg.needed}`);
  }

  await browser.close();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync('nuevas-categorias-candidatos.json', 'utf8')); } catch (e) {}
  const merged = { ...prev, ...out };
  fs.writeFileSync('nuevas-categorias-candidatos.json', JSON.stringify(merged, null, 2), 'utf8');
  console.log('\nGuardado en nuevas-categorias-candidatos.json');
})();
