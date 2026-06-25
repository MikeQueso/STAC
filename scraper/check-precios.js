// STAC · Revisión diaria de precios en Cyberpuerta, Abasteo y DD Tech
//
// Busca cada producto de tu catálogo por nombre en los 3 sitios, toma el
// precio más bajo que encuentre y lo guarda en la tabla `precios_abasto`
// de Supabase. No toca tu precio de venta — eso lo decide tu papá desde
// el panel admin.
//
// Variables de entorno requeridas (se configuran como Secrets en GitHub
// Actions, nunca se escriben aquí):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role key, NO la anon key)
//   ABASTEO_USER, ABASTEO_PASS
//   DDTECH_USER, DDTECH_PASS

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ABASTEO_USER = process.env.ABASTEO_USER;
const ABASTEO_PASS = process.env.ABASTEO_PASS;
const DDTECH_USER = process.env.DDTECH_USER;
const DDTECH_PASS = process.env.DDTECH_PASS;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,]/g, '').replace(/,/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── CYBERPUERTA (público, sin login) ──────────────────────────────
async function searchCyberpuerta(page, productName) {
  const url = `https://www.cyberpuerta.mx/index.php?cl=search&searchparam=${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const items = await page.$$eval('.itemlist .product-item, .product-list-item, article.product', (nodes) =>
    nodes.slice(0, 5).map((n) => ({
      title: n.querySelector('.product-name, .name, h2, h3')?.textContent?.trim() || '',
      price: n.querySelector('.price, .product-price, .precio')?.textContent?.trim() || '',
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);

  return items;
}

// ─── ABASTEO (requiere login) ──────────────────────────────────────
async function loginAbasteo(page) {
  await page.goto('https://www.abasteo.com.mx/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', ABASTEO_USER);
  await page.fill('input[type="password"], input[name="password"]', ABASTEO_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
}

async function searchAbasteo(page, productName) {
  const url = `https://www.abasteo.com.mx/search?q=${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const items = await page.$$eval('.product-card, .product-item, article.product', (nodes) =>
    nodes.slice(0, 5).map((n) => ({
      title: n.querySelector('.product-name, .name, h2, h3')?.textContent?.trim() || '',
      price: n.querySelector('.price, .product-price, .precio')?.textContent?.trim() || '',
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);

  return items;
}

// ─── DD TECH (requiere login) ──────────────────────────────────────
async function loginDDTech(page) {
  await page.goto('https://www.ddtech.com.mx/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', DDTECH_USER);
  await page.fill('input[type="password"], input[name="password"]', DDTECH_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
}

async function searchDDTech(page, productName) {
  const url = `https://www.ddtech.com.mx/catalogsearch/result/?q=${encodeURIComponent(productName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const items = await page.$$eval('.product-item, li.item.product', (nodes) =>
    nodes.slice(0, 5).map((n) => ({
      title: n.querySelector('.product-item-link, .name, h2, h3')?.textContent?.trim() || '',
      price: n.querySelector('.price, .product-price')?.textContent?.trim() || '',
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);

  return items;
}

// Elige, de los resultados de un sitio, el que mejor coincide con el nombre
// del producto (coincidencia simple por palabras en común) y devuelve su precio.
function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const wantedWords = productName.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const titleLower = item.title.toLowerCase();
    const score = wantedWords.filter((w) => titleLower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = { ...item, price };
    }
  }
  // Exige al menos 1 palabra en común para evitar matches absurdos
  return bestScore > 0 ? best : null;
}

async function run() {
  const { data: products, error } = await sb.from('products').select('id, name');
  if (error) {
    console.error('No se pudo leer products:', error.message);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const hasAbasteo = ABASTEO_USER && ABASTEO_PASS;
  const hasDDTech = DDTECH_USER && DDTECH_PASS;

  if (hasAbasteo) {
    try { await loginAbasteo(page); } catch (e) { console.error('Login Abasteo falló:', e.message); }
  }

  const rows = [];

  for (const product of products) {
    console.log(`Buscando: ${product.name}`);

    try {
      const cpItems = await searchCyberpuerta(page, product.name);
      const cpMatch = pickBestMatch(product.name, cpItems);
      if (cpMatch) {
        rows.push({
          product_id: product.id,
          proveedor: 'Cyberpuerta',
          precio: cpMatch.price,
          url: cpMatch.url,
          encontrado_como: cpMatch.title,
          actualizado_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error(`Cyberpuerta error en "${product.name}":`, e.message);
    }

    if (hasAbasteo) {
      try {
        const abItems = await searchAbasteo(page, product.name);
        const abMatch = pickBestMatch(product.name, abItems);
        if (abMatch) {
          rows.push({
            product_id: product.id,
            proveedor: 'Abasteo',
            precio: abMatch.price,
            url: abMatch.url,
            encontrado_como: abMatch.title,
            actualizado_at: new Date().toISOString()
          });
        }
      } catch (e) {
        console.error(`Abasteo error en "${product.name}":`, e.message);
      }
    }
  }

  // DD Tech en un contexto/página aparte (sesión distinta)
  if (hasDDTech) {
    const ddPage = await context.newPage();
    try { await loginDDTech(ddPage); } catch (e) { console.error('Login DD Tech falló:', e.message); }

    for (const product of products) {
      try {
        const ddItems = await searchDDTech(ddPage, product.name);
        const ddMatch = pickBestMatch(product.name, ddItems);
        if (ddMatch) {
          rows.push({
            product_id: product.id,
            proveedor: 'DD Tech',
            precio: ddMatch.price,
            url: ddMatch.url,
            encontrado_como: ddMatch.title,
            actualizado_at: new Date().toISOString()
          });
        }
      } catch (e) {
        console.error(`DD Tech error en "${product.name}":`, e.message);
      }
    }
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
    console.log(`Guardados ${rows.length} precios.`);
  } else {
    console.log('No se encontró ningún precio coincidente.');
  }
}

run();
