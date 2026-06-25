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
//   DEBUG_DUMP=1   -> guarda HTML de una búsqueda de cada sitio en
//                     debug-*.html (se sube como artifact para inspección)

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

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^\d.,]/g, '').replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── CYBERPUERTA (público, server-rendered) ────────────────────────
async function searchCyberpuerta(page, productName) {
  const url = `https://www.cyberpuerta.mx/index.php?cl=search&searchparam=${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);

  return await page.$$eval('.cpd-product-card-catalog-list', (nodes) =>
    nodes.slice(0, 8).map((n) => {
      const a = n.querySelector('a.cp-product-info-dne');
      const priceEl = n.querySelector('.cpd-product-card-catalog-list__price');
      return {
        title: (a?.getAttribute('title') || a?.textContent || '').trim(),
        price: (priceEl?.textContent || '').trim(),
        url: a?.href || ''
      };
    })
  ).catch(() => []);
}

// ─── ABASTEO (abasteo.mx · SPA Vue, precios tras login) ─────────────
// Selectores y rutas pendientes de confirmar con el HTML real logueado.
async function loginAbasteo(page) {
  await page.goto('https://www.abasteo.mx/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // TODO: ajustar al flujo real de login una vez visto el DOM logueado.
}

async function searchAbasteo(page, productName) {
  const url = `https://www.abasteo.mx/buscar/${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  return await page.$$eval('.product-card, .producto, [class*="product"]', (nodes) =>
    nodes.slice(0, 8).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

// ─── DD TECH (ddtech.mx · resultados por JS, precios tras login) ────
async function loginDDTech(page) {
  await page.goto('https://ddtech.mx/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // TODO: ajustar al flujo real de login una vez visto el DOM logueado.
}

async function searchDDTech(page, productName) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(productName).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  return await page.$$eval('[class*="product"], .producto, article', (nodes) =>
    nodes.slice(0, 8).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3, a')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

// Elige el resultado que mejor coincide con el nombre del producto
// (coincidencia por palabras en común) y devuelve su precio.
function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const wantedWords = productName.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const titleLower = (item.title || '').toLowerCase();
    const score = wantedWords.filter((w) => titleLower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = { ...item, price };
    }
  }
  // Exige al menos 2 palabras en común para evitar matches absurdos
  return bestScore >= 2 ? best : null;
}

async function run() {
  const { data: products, error } = await sb.from('products').select('id, name');
  if (error) {
    console.error('No se pudo leer products:', error.message);
    process.exit(1);
  }
  console.log(`Catálogo: ${products.length} productos.`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  });
  const page = await context.newPage();

  const hasAbasteo = ABASTEO_USER && ABASTEO_PASS;
  const hasDDTech = DDTECH_USER && DDTECH_PASS;

  // Modo debug: guarda el HTML real de una búsqueda de cada sitio para
  // poder ajustar los selectores sin adivinar.
  if (DEBUG_DUMP) {
    const sample = 'kingston nv2 1tb';
    try {
      await searchCyberpuerta(page, sample);
      fs.writeFileSync('debug-cyberpuerta.html', await page.content());
      console.log('debug-cyberpuerta.html guardado');
    } catch (e) { console.error('dump cyberpuerta:', e.message); }

    if (hasAbasteo) {
      try {
        await loginAbasteo(page);
        await searchAbasteo(page, sample);
        fs.writeFileSync('debug-abasteo.html', await page.content());
        console.log('debug-abasteo.html guardado');
      } catch (e) { console.error('dump abasteo:', e.message); }
    }
    if (hasDDTech) {
      try {
        await loginDDTech(page);
        await searchDDTech(page, sample);
        fs.writeFileSync('debug-ddtech.html', await page.content());
        console.log('debug-ddtech.html guardado');
      } catch (e) { console.error('dump ddtech:', e.message); }
    }
    await browser.close();
    console.log('Modo DEBUG_DUMP: solo se guardaron los HTML, no se escribió en Supabase.');
    return;
  }

  const rows = [];
  let conCyber = 0, conAbasteo = 0, conDD = 0;

  // ── Cyberpuerta (sin login) ──
  for (const product of products) {
    try {
      const items = await searchCyberpuerta(page, product.name);
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
  }
  console.log(`Cyberpuerta: ${conCyber}/${products.length} con precio.`);

  // ── Abasteo (con login) ──
  if (hasAbasteo) {
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
      } catch (e) {
        console.error(`Abasteo "${product.name}":`, e.message);
      }
    }
    console.log(`Abasteo: ${conAbasteo}/${products.length} con precio.`);
  }

  // ── DD Tech (con login, página aparte) ──
  if (hasDDTech) {
    const ddPage = await context.newPage();
    try { await loginDDTech(ddPage); } catch (e) { console.error('Login DD Tech:', e.message); }
    for (const product of products) {
      try {
        const items = await searchDDTech(ddPage, product.name);
        const match = pickBestMatch(product.name, items);
        if (match) {
          conDD++;
          rows.push({
            product_id: product.id, proveedor: 'DD Tech', precio: match.price,
            url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString()
          });
        }
      } catch (e) {
        console.error(`DD Tech "${product.name}":`, e.message);
      }
    }
    console.log(`DD Tech: ${conDD}/${products.length} con precio.`);
    await ddPage.close();
  }

  await browser.close();

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
