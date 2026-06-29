// Reintenta, con búsquedas más cortas, los productos que NO encontraron
// precio en ninguna tienda en la última corrida. Inserta de forma puntual
// (por product_id+proveedor) — nunca borra en bloque, así no hay riesgo de
// vaciar la tabla si algo falla.
try { require('dotenv').config(); } catch (e) {}
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
function tokenize(s) { return s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean); }

function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const wanted = tokenize(productName);
  const wantedSig = [...new Set(wanted.filter((w) => w.length > 2))];
  const digitToks = wanted.filter((w) => /\d/.test(w));
  const isUnit = (t) => /^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm|bit)$/.test(t) || /^\d+x\d+$/.test(t);
  const modelLike = digitToks.filter((t) => /[a-z]/.test(t) && !isUnit(t));
  const pureNum = digitToks.filter((t) => !isUnit(t) && !/[a-z]/.test(t));
  const keyModel = modelLike.sort((a, b) => b.length - a.length)[0] || pureNum.sort((a, b) => b.length - a.length)[0] || null;
  const productIsBuild = /comput|laptop|combo|bundle|\bpc\b|\bkit\b/i.test(productName);
  const wantedSet = new Set(wanted);
  const VARIANT_QUALIFIERS = ['ti', 'super'];
  const words = productName.split(/\s+/);
  let brand = (words[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (brand.length <= 3 && words[1]) brand += words[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const caps = wanted.filter((w) => /^\d+(gb|tb)$/.test(w));
  const prodHasBadKind = /mantenim|so-?dimm/i.test(productName);

  let best = null; let bestScore = 1;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const title = item.title || '';
    const titleStr = title.toLowerCase();
    const titleNorm = titleStr.replace(/[^a-z0-9]/g, '');
    const tokSet = new Set(tokenize(title));
    if (!productIsBuild && /comput|laptop|combo|bundle/i.test(title)) continue;
    if (!prodHasBadKind && /mantenim|so-?dimm/i.test(title)) continue;
    if (brand && !titleNorm.includes(brand)) continue;
    if (caps.some((c) => !titleNorm.includes(c))) continue;
    // El modelo puede venir pegado a un prefijo de letra en el título real
    // (TN-660 en el catálogo == TN660 en la tienda; 664 == T664).
    const keyModelOk = !keyModel || tokSet.has(keyModel) || [...tokSet].some((t) => t.endsWith(keyModel) && /[a-z]/.test(t));
    if (!keyModelOk) continue;
    if (VARIANT_QUALIFIERS.some((q) => tokSet.has(q) && !wantedSet.has(q))) continue;
    const score = wantedSig.filter((w) => titleStr.includes(w)).length;
    if (score > bestScore || (score === bestScore && best && price < best.price)) {
      bestScore = score; best = { ...item, price };
    }
  }
  return best;
}

async function ddSearch(page, q) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(q).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.product h3.name'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  return await page.$$eval('.product', (nodes) => nodes.slice(0, 16).map((n) => ({
    title: (n.querySelector('h3.name, .name')?.textContent || '').trim(),
    price: (n.querySelector('.price, .product-price')?.textContent || '').trim(),
    url: n.querySelector('a[href*="/producto/"]')?.href || '',
  })).filter((x) => x.title)).catch(() => []);
}
async function abasteoSearch(page, q) {
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-product-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  return await page.$$eval('.c-product-card', (nodes) => nodes.slice(0, 14).map((n) => ({
    title: (n.querySelector('.c-product-pic__product-img')?.getAttribute('alt') || '').trim(),
    price: (n.querySelector('.c-product-price__price')?.textContent || '').trim(),
    url: n.querySelector('.c-product-pic__link')?.href || '',
  }))).catch(() => []);
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
    const u = b.match(/"url":\s*"([^"]+)"/);
    if (n && p) items.push({ title: n[1], price: p[1], url: u ? u[1].replace(':443', '') : '' });
  }
  return items;
}

// Productos sin precio (nombre exacto en DB) + queries cortas a probar en orden:
// [DD Tech queries..., Abasteo queries..., Office Depot queries...]
const RESCATE = [
  { name: 'Unidad de Estado Sólido SSD Adata Legend 900 NVMe', dd: ['Adata Legend 900'] },
  { name: 'Kingston Fury Beast 16GB (2x8) DDR4 3200MHz', dd: ['Kingston Fury Beast DDR4'] },
  { name: 'Memoria RAM ADATA XPG GAMMIX D10 DDR4 32GB (2x16GB) 3000MHz CL16 Negra', dd: ['ADATA XPG GAMMIX D10'] },
  { name: 'Disipador para CPU BALAM RUSH Heliux Pro HEX55', dd: ['balam rush heliux'] },
  { name: 'Disipador para CPU BALAM RUSH Heliux Pro HEX70', dd: ['balam rush heliux'] },
  { name: 'Brother TN-660 Toner Negro', od: ['Brother TN-660'] },
  { name: 'Epson 664 Negro', od: ['Epson T664 Negro'] },
];
(async () => {
  const { data: products } = await sb.from('products').select('id, name');
  const byName = new Map(products.map((p) => [p.name, p.id]));

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ userAgent: UA })).newPage();

  let ok = 0, fail = 0;
  for (const r of RESCATE) {
    const id = byName.get(r.name);
    if (!id) { console.log(`⚠ no existe en DB: "${r.name}"`); continue; }
    let found = false;

    for (const q of r.dd || []) {
      const items = await ddSearch(page, q);
      const match = pickBestMatch(r.name, items);
      if (match) {
        await sb.from('precios_abasto').delete().eq('product_id', id).eq('proveedor', 'DD Tech');
        await sb.from('precios_abasto').insert({ product_id: id, proveedor: 'DD Tech', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
        console.log(`✔ DD Tech  $${match.price}  ${r.name.slice(0, 50)}`);
        found = true; ok++; break;
      }
    }
    if (found) continue;

    for (const q of r.abasteo || []) {
      const items = await abasteoSearch(page, q);
      const match = pickBestMatch(r.name, items);
      if (match) {
        await sb.from('precios_abasto').delete().eq('product_id', id).eq('proveedor', 'Abasteo');
        await sb.from('precios_abasto').insert({ product_id: id, proveedor: 'Abasteo', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
        console.log(`✔ Abasteo  $${match.price}  ${r.name.slice(0, 50)}`);
        found = true; ok++; break;
      }
    }
    if (found) continue;

    for (const q of r.od || []) {
      const items = await odSearch(q);
      const match = pickBestMatch(r.name, items);
      if (match) {
        await sb.from('precios_abasto').delete().eq('product_id', id).eq('proveedor', 'Office Depot');
        await sb.from('precios_abasto').insert({ product_id: id, proveedor: 'Office Depot', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
        console.log(`✔ OfficeDepot  $${match.price}  ${r.name.slice(0, 50)}`);
        found = true; ok++; break;
      }
    }
    if (!found) { console.log(`✘ sin match: ${r.name}`); fail++; }
  }

  await browser.close();
  console.log(`\nRescatados: ${ok} | Sin match: ${fail}`);
})();
