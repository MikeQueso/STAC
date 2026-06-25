// STAC · Revisión diaria de precios en Cyberpuerta, Abasteo y DD Tech
//
// Busca cada producto de tu catálogo por nombre en los sitios de los
// proveedores, toma el precio más bajo que encuentre y lo guarda en la
// tabla `precios_abasto` de Supabase. No toca tu precio de venta — eso
// lo decide el admin desde el Panel Admin.
//
// Variables de entorno (Secrets en GitHub Actions, nunca en el código):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   ABASTEO_USER, ABASTEO_PASS, DDTECH_USER, DDTECH_PASS
//
// Flags opcionales:
//   DEBUG_DUMP=1   -> guarda HTML de una búsqueda de cada sitio para inspección

const fs = require('fs');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ABASTEO_USER = process.env.ABASTEO_USER;
const ABASTEO_PASS = process.env.ABASTEO_PASS;
const DDTECH_USER = process.env.DDTECH_USER;
const DDTECH_PASS = process.env.DDTECH_PASS;
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';
// Abasteo aún no tiene login implementado; se apaga para no perder tiempo.
// Cuando esté listo, poner ABASTEO_ENABLED=1 en el workflow.
const ABASTEO_ENABLED = process.env.ABASTEO_ENABLED === '1';

// Ejecuta `fn` sobre `items` con como máximo `concurrency` tareas a la vez.
async function mapPool(items, concurrency, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Precio: toma el número MÁS BAJO de un texto (maneja "precio normal +
//     precio oferta" pegados, p.ej. "$2,199.00 $2,499.00") ──────────────
function parsePrice(text) {
  if (!text) return null;
  const matches = String(text).match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!matches) return null;
  const nums = matches.map((m) => parseFloat(m.replace(/,/g, ''))).filter((n) => !isNaN(n) && n > 0);
  return nums.length ? Math.min(...nums) : null;
}

function tokenize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Elige el resultado que mejor coincide con el nombre del producto.
// - Rechaza computadoras/laptops/combos (cuando el producto no lo es).
// - Exige que el token de modelo más específico (el más largo con dígitos)
//   coincida EXACTO, para no confundir 5600 con 5600XT, 13900K con 13900KS, etc.
function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const wanted = tokenize(productName);
  const wantedSig = [...new Set(wanted.filter((w) => w.length > 2))];
  const digitToks = wanted.filter((w) => /\d/.test(w));
  const keyModel = digitToks.sort((a, b) => b.length - a.length)[0] || null;
  const productIsBuild = /comput|laptop|combo|bundle|\bpc\b|\bkit\b/i.test(productName);

  let best = null;
  let bestScore = 1; // exige al menos 2 palabras significativas en común
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const title = item.title || '';
    if (!productIsBuild && /comput|laptop|combo|bundle/i.test(title)) continue;
    const tokSet = new Set(tokenize(title));
    if (keyModel && !tokSet.has(keyModel)) continue;
    const titleStr = title.toLowerCase();
    const score = wantedSig.filter((w) => titleStr.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = { ...item, price }; }
  }
  return best;
}

// ─── CYBERPUERTA (HTTP directo · sin navegador, evita la detección de bot) ──
async function searchCyberpuerta(productName) {
  const url = `https://www.cyberpuerta.mx/index.php?cl=search&searchparam=${encodeURIComponent(productName)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' } });
  if (!res.ok) return { items: [], html: '' };
  const html = await res.text();

  const names = [];
  const cardRe = /<a href="(\/[^"]+)"\s+class="cp-product-info-dne[^"]*"\s+title="([^"]*)"/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    names.push({ url: 'https://www.cyberpuerta.mx' + m[1], title: m[2] });
  }
  const prices = [];
  const priceRe = /cp-text--price-total[^>]*>(?:<!--\[-->)?\s*\$?\s*([\d,]+(?:\.\d{2})?)/g;
  while ((m = priceRe.exec(html)) !== null) prices.push(m[1]);

  const items = names.map((n, i) => ({ title: n.title, url: n.url, price: prices[i] || '' }));
  return { items, html };
}

// ─── DD TECH (ddtech.mx · resultados por JS → requiere navegador) ───────────
async function searchDDTech(page, productName) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(productName).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Espera a que aparezcan los productos (rápido) + margen para que el JS
  // termine de pintar los resultados reales de la búsqueda.
  await page.waitForSelector('[class*="product"], .producto, article', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1000);

  return await page.$$eval('[class*="product"], .producto, article', (nodes) =>
    nodes.slice(0, 10).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3, a')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

// ─── ABASTEO (abasteo.mx · SPA con precios tras login) ──────────────────────
// Pendiente: implementar login real una vez visto el DOM logueado.
async function loginAbasteo(page) {
  await page.goto('https://www.abasteo.mx/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
}
async function searchAbasteo(page, productName) {
  const url = `https://www.abasteo.mx/buscar/${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  return await page.$$eval('[class*="product"], .producto', (nodes) =>
    nodes.slice(0, 10).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

async function run() {
  const { data: products, error } = await sb.from('products').select('id, name');
  if (error) {
    console.error('No se pudo leer products:', error.message);
    process.exit(1);
  }
  console.log(`Catálogo: ${products.length} productos.`);

  const hasAbasteo = ABASTEO_ENABLED && ABASTEO_USER && ABASTEO_PASS;
  const hasDDTech = DDTECH_USER && DDTECH_PASS;
  const t0 = Date.now();

  // Modo debug: guarda el HTML real de una búsqueda de cada sitio.
  if (DEBUG_DUMP) {
    const sample = 'kingston nv2 1tb';
    try {
      const { html } = await searchCyberpuerta(sample);
      fs.writeFileSync('debug-cyberpuerta.html', html);
      console.log('debug-cyberpuerta.html guardado');
    } catch (e) { console.error('dump cyberpuerta:', e.message); }

    const browser = await chromium.launch();
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    if (hasDDTech) {
      try { await searchDDTech(page, sample); fs.writeFileSync('debug-ddtech.html', await page.content()); console.log('debug-ddtech.html guardado'); }
      catch (e) { console.error('dump ddtech:', e.message); }
    }
    if (hasAbasteo) {
      try { await loginAbasteo(page); await searchAbasteo(page, sample); fs.writeFileSync('debug-abasteo.html', await page.content()); console.log('debug-abasteo.html guardado'); }
      catch (e) { console.error('dump abasteo:', e.message); }
    }
    await browser.close();
    console.log('Modo DEBUG_DUMP: solo se guardaron los HTML, no se escribió en Supabase.');
    return;
  }

  const rows = [];
  let conCyber = 0, conAbasteo = 0, conDD = 0;

  // ── Cyberpuerta (HTTP directo, en paralelo) ──
  await mapPool(products, 4, async (product) => {
    try {
      const { items } = await searchCyberpuerta(product.name);
      const match = pickBestMatch(product.name, items);
      if (match) {
        conCyber++;
        rows.push({
          product_id: product.id, proveedor: 'Cyberpuerta', precio: match.price,
          url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error(`Cyberpuerta "${product.name}":`, e.message);
    }
  });
  console.log(`Cyberpuerta: ${conCyber}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // ── DD Tech y Abasteo (con navegador, varias pestañas en paralelo) ──
  if (hasDDTech || hasAbasteo) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ userAgent: UA });

    if (hasDDTech) {
      const CONC = 3;
      const pages = await Promise.all(Array.from({ length: CONC }, () => context.newPage()));
      let i = 0;
      await Promise.all(pages.map(async (page) => {
        while (i < products.length) {
          const product = products[i++];
          try {
            const items = await searchDDTech(page, product.name);
            const match = pickBestMatch(product.name, items);
            if (match) {
              conDD++;
              rows.push({
                product_id: product.id, proveedor: 'DD Tech', precio: match.price,
                url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString()
              });
            }
          } catch (e) { console.error(`DD Tech "${product.name}":`, e.message); }
        }
      }));
      await Promise.all(pages.map((p) => p.close()));
      console.log(`DD Tech: ${conDD}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }

    if (hasAbasteo) {
      const page = await context.newPage();
      try { await loginAbasteo(page); } catch (e) { console.error('Login Abasteo:', e.message); }
      for (const product of products) {
        try {
          const items = await searchAbasteo(page, product.name);
          const match = pickBestMatch(product.name, items);
          if (match) {
            conAbasteo++;
            rows.push({
              product_id: product.id, proveedor: 'Abasteo', precio: match.price,
              url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString()
            });
          }
        } catch (e) { console.error(`Abasteo "${product.name}":`, e.message); }
      }
      await page.close();
      console.log(`Abasteo: ${conAbasteo}/${products.length} con precio.`);
    }

    await browser.close();
  }

  if (rows.length) {
    const { error: upsertError } = await sb
      .from('precios_abasto')
      .upsert(rows, { onConflict: 'product_id,proveedor' });
    if (upsertError) {
      console.error('Error guardando en Supabase:', upsertError.message);
      process.exit(1);
    }
    console.log(`Guardados ${rows.length} precios en total.`);
  } else {
    console.log('No se encontró ningún precio coincidente.');
  }
}

run();
