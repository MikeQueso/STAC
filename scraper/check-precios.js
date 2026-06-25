// STAC · Revisión diaria de precios en DD Tech y Abasteo
//
// Busca cada producto del catálogo por nombre en los sitios de los
// proveedores, toma el precio más bajo que encuentre y lo guarda en la
// tabla `precios_abasto` de Supabase. No toca tu precio de venta — eso
// lo decide el admin desde el Panel Admin.
//
// Variables de entorno (Secrets en GitHub Actions, nunca en el código):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   ABASTEO_USER, ABASTEO_PASS, DDTECH_USER, DDTECH_PASS
//
// Flags opcionales:
//   DEBUG_DUMP=1       -> guarda el HTML renderizado de cada sitio para inspección
//   ABASTEO_ENABLED=1  -> activa Abasteo (mientras se afina su login/búsqueda)

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
const ABASTEO_ENABLED = process.env.ABASTEO_ENABLED === '1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Precio: toma el número MÁS BAJO de un texto (maneja "normal + oferta" pegados).
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
function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const wanted = tokenize(productName);
  const wantedSig = [...new Set(wanted.filter((w) => w.length > 2))];
  const digitToks = wanted.filter((w) => /\d/.test(w));
  const keyModel = digitToks.sort((a, b) => b.length - a.length)[0] || null;
  const productIsBuild = /comput|laptop|combo|bundle|\bpc\b|\bkit\b/i.test(productName);
  const wantedSet = new Set(wanted);
  const VARIANT_QUALIFIERS = ['ti', 'super'];

  let best = null;
  let bestScore = 1;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const title = item.title || '';
    if (!productIsBuild && /comput|laptop|combo|bundle/i.test(title)) continue;
    const tokSet = new Set(tokenize(title));
    if (keyModel && !tokSet.has(keyModel)) continue;
    if (VARIANT_QUALIFIERS.some((q) => tokSet.has(q) && !wantedSet.has(q))) continue;
    const titleStr = title.toLowerCase();
    const score = wantedSig.filter((w) => titleStr.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = { ...item, price }; }
  }
  return best;
}

// ─── DD TECH (ddtech.mx · resultados por JS → requiere navegador) ───────────
async function searchDDTech(page, productName) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(productName).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href*="/producto/"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);

  return await page.$$eval('[class*="product"], .producto, article', (nodes) =>
    nodes.slice(0, 10).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3, a')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

// ─── ABASTEO (abasteo.mx · Knockout/jQuery · login en modal "Acceso a cuenta") ──
// El login es un modal, no una página. Estos selectores se afinan con el DOM
// real capturado por DEBUG_DUMP.
async function loginAbasteo(page) {
  await page.goto('https://www.abasteo.mx/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  // Abrir el modal de login
  for (const sel of ['text=Acceso a cuenta', 'text=Iniciar sesión', 'a[href*="login"]', 'button:has-text("cuenta")']) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(1500);
  await page.fill('input[type="email"], input[name="email"], input[name="correo"]', ABASTEO_USER).catch(() => {});
  await page.fill('input[type="password"], input[name="password"], input[name="contrasena"]', ABASTEO_PASS).catch(() => {});
  for (const sel of ['button[type="submit"]', 'text=Iniciar sesión', 'text=Entrar', 'text=Acceder']) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(3000);
}

async function searchAbasteo(page, productName) {
  // Búsqueda vía la caja "¿Qué necesita su empresa?" (selector se afina con DEBUG_DUMP)
  const box = await page.$('input[type="search"], input[name="q"], input[placeholder*="necesita"], input[placeholder*="Buscar"]').catch(() => null);
  if (box) {
    await box.fill(productName).catch(() => {});
    await box.press('Enter').catch(() => {});
    await page.waitForTimeout(3000);
  }
  return await page.$$eval('[class*="product"], [class*="producto"], .item', (nodes) =>
    nodes.slice(0, 10).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], [class*="nombre"], h2, h3, a')?.textContent || '').trim(),
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

  // Modo debug: captura el HTML renderizado para afinar selectores.
  if (DEBUG_DUMP) {
    const sample = 'kingston nv2 1tb';
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ userAgent: UA })).newPage();

    if (hasDDTech) {
      try { await searchDDTech(page, sample); fs.writeFileSync('debug-ddtech.html', await page.content()); console.log('debug-ddtech.html guardado'); }
      catch (e) { console.error('dump ddtech:', e.message); }
    }

    // Abasteo: captura home renderizado (para ver botón de login + caja de búsqueda)
    if (ABASTEO_USER && ABASTEO_PASS) {
      try {
        await page.goto('https://www.abasteo.mx/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        fs.writeFileSync('debug-abasteo-home.html', await page.content());
        console.log('debug-abasteo-home.html guardado');
        await loginAbasteo(page);
        fs.writeFileSync('debug-abasteo-postlogin.html', await page.content());
        console.log('debug-abasteo-postlogin.html guardado');
        await searchAbasteo(page, sample);
        fs.writeFileSync('debug-abasteo-search.html', await page.content());
        console.log('debug-abasteo-search.html guardado');
      } catch (e) { console.error('dump abasteo:', e.message); }
    }

    await browser.close();
    console.log('Modo DEBUG_DUMP: solo se guardaron los HTML, no se escribió en Supabase.');
    return;
  }

  const rows = [];
  let conAbasteo = 0, conDD = 0;

  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: UA });

  // ── DD Tech (4 pestañas en paralelo) ──
  if (hasDDTech) {
    const CONC = 4;
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

  // ── Abasteo (1 sesión con login) ──
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
    console.log(`Abasteo: ${conAbasteo}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  await browser.close();

  // Borra lo viejo de los proveedores que sí corrieron e inserta lo nuevo.
  const provasCorridos = [];
  if (hasDDTech) provasCorridos.push('DD Tech');
  if (hasAbasteo) provasCorridos.push('Abasteo');

  if (provasCorridos.length) {
    const { error: delError } = await sb.from('precios_abasto').delete().in('proveedor', provasCorridos);
    if (delError) console.error('Error borrando precios viejos:', delError.message);
  }

  if (rows.length) {
    const { error: insError } = await sb.from('precios_abasto').insert(rows);
    if (insError) {
      console.error('Error guardando en Supabase:', insError.message);
      process.exit(1);
    }
    console.log(`Guardados ${rows.length} precios en total.`);
  } else {
    console.log('No se encontró ningún precio coincidente.');
  }
}

run();
