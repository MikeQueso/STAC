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

  // Marca: primera palabra del producto (normalizada sin signos). Si es muy
  // corta (MSI, AMD, be...), se concatena la segunda para mayor precisión.
  const words = productName.split(/\s+/);
  let brand = (words[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (brand.length <= 3 && words[1]) brand += words[1].toLowerCase().replace(/[^a-z0-9]/g, '');

  // Capacidades (16GB, 1TB…) que el resultado DEBE tener para no confundir
  // 16GB con 8GB, 1TB con 500GB, etc.
  const caps = wanted.filter((w) => /^\d+(gb|tb)$/.test(w));

  // El producto no es un kit de mantenimiento ni RAM de laptop, salvo que su
  // propio nombre lo diga.
  const prodHasBadKind = /mantenim|so-?dimm/i.test(productName);

  let best = null;
  let bestScore = 1;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const title = item.title || '';
    const titleStr = title.toLowerCase();
    const titleNorm = titleStr.replace(/[^a-z0-9]/g, '');
    const tokSet = new Set(tokenize(title));

    if (!productIsBuild && /comput|laptop|combo|bundle/i.test(title)) continue;
    if (!prodHasBadKind && /mantenim|so-?dimm/i.test(title)) continue;
    if (brand && !titleNorm.includes(brand)) continue;       // misma marca
    if (caps.some((c) => !tokSet.has(c))) continue;           // misma capacidad
    if (keyModel && !tokSet.has(keyModel)) continue;          // mismo modelo
    if (VARIANT_QUALIFIERS.some((q) => tokSet.has(q) && !wantedSet.has(q))) continue;

    const score = wantedSig.filter((w) => titleStr.includes(w)).length;
    // Mejor puntaje gana; en empate, el precio más bajo.
    if (score > bestScore || (score === bestScore && best && price < best.price)) {
      bestScore = score; best = { ...item, price };
    }
  }
  return best;
}

// Acorta el nombre a lo distintivo (marca + modelo + capacidad) quitando
// palabras genéricas que hacen que el buscador no encuentre nada. El
// comparador (pickBestMatch) sigue validando contra el nombre completo.
const GENERIC = new Set([
  'ssd', 'sata', 'nvme', 'hdd', 'm.2', 'm2', 'modular', 'plus', 'gold', 'bronze',
  'platinum', 'white', '80+', 'para', 'con', 'de', 'la', 'el', 'set', '(set)',
  'toner', 'tóner', 'cartucho', 'tinta', 'original'
]);
function searchQuery(name) {
  const kept = name.split(/\s+/).filter((w) => {
    const c = w.toLowerCase().replace(/[.,()]/g, '');
    return c && !GENERIC.has(c);
  });
  const q = kept.join(' ').trim();
  return q.length >= 3 ? q : name;
}

// ─── DD TECH (ddtech.mx · resultados por JS → requiere navegador) ───────────
async function searchDDTech(page, productName) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(searchQuery(productName)).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href*="/producto/"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);

  return await page.$$eval('[class*="product"], .producto, article', (nodes) =>
    nodes.slice(0, 14).map((n) => ({
      title: (n.querySelector('[class*="name"], [class*="title"], h2, h3, a')?.textContent || '').trim(),
      price: (n.querySelector('[class*="price"], [class*="precio"]')?.textContent || '').trim(),
      url: n.querySelector('a')?.href || ''
    }))
  ).catch(() => []);
}

// ─── ABASTEO (abasteo.mx · misma plataforma OXID que Cyberpuerta, precios
//     públicos · resultados por JS → requiere navegador) ────────────────────
async function searchAbasteo(page, productName) {
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(searchQuery(productName))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-product-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

  return await page.$$eval('.c-product-card', (nodes) =>
    nodes.slice(0, 14).map((n) => ({
      title: (n.querySelector('.c-product-pic__product-img')?.getAttribute('alt') || '').trim(),
      price: (n.querySelector('.c-product-price__price')?.textContent || '').trim(),
      url: n.querySelector('.c-product-pic__link')?.href || ''
    }))
  ).catch(() => []);
}

// ─── OFFICE DEPOT MX (officedepot.com.mx · precios en JSON-LD del HTML →
//     HTTP directo, sin navegador) · útil para tintas/cartuchos ────────────
async function searchOfficeDepot(productName) {
  const url = `https://www.officedepot.com.mx/search?text=${encodeURIComponent(searchQuery(productName))}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' } }).catch(() => null);
  if (!res || !res.ok) return [];
  const html = await res.text();
  const items = [];
  for (const blk of html.split('"@type": "Product"').slice(1)) {
    const b = blk.slice(0, 1400);
    const n = b.match(/"name":\s*"([^"]+)"/);
    const p = b.match(/"price":\s*"?([0-9.]+)"?/);
    const u = b.match(/"url":\s*"([^"]+)"/);
    if (n && p) items.push({ title: n[1], price: p[1], url: u ? u[1].replace(':443', '') : '' });
  }
  return items;
}

async function run() {
  const { data: products, error } = await sb.from('products').select('id, name');
  if (error) {
    console.error('No se pudo leer products:', error.message);
    process.exit(1);
  }
  console.log(`Catálogo: ${products.length} productos.`);

  const hasAbasteo = ABASTEO_ENABLED; // precios públicos, no requiere login
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

    try { await searchAbasteo(page, sample); fs.writeFileSync('debug-abasteo-search.html', await page.content()); console.log('debug-abasteo-search.html guardado'); }
    catch (e) { console.error('dump abasteo:', e.message); }

    await browser.close();
    console.log('Modo DEBUG_DUMP: solo se guardaron los HTML, no se escribió en Supabase.');
    return;
  }

  const rows = [];
  let conAbasteo = 0, conDD = 0, conOD = 0;

  // ── Office Depot (HTTP directo, en paralelo) · sobre todo tintas ──
  await mapPool(products, 4, async (product) => {
    try {
      const items = await searchOfficeDepot(product.name);
      const match = pickBestMatch(product.name, items);
      if (match) {
        conOD++;
        rows.push({
          product_id: product.id, proveedor: 'Office Depot', precio: match.price,
          url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString()
        });
      }
    } catch (e) { console.error(`Office Depot "${product.name}":`, e.message); }
  });
  console.log(`Office Depot: ${conOD}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

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

  // ── Abasteo (4 pestañas en paralelo, precios públicos) ──
  if (hasAbasteo) {
    const CONC = 4;
    const pages = await Promise.all(Array.from({ length: CONC }, () => context.newPage()));
    let i = 0;
    await Promise.all(pages.map(async (page) => {
      while (i < products.length) {
        const product = products[i++];
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
    }));
    await Promise.all(pages.map((p) => p.close()));
    console.log(`Abasteo: ${conAbasteo}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  await browser.close();

  // Borra lo viejo de los proveedores que sí corrieron e inserta lo nuevo.
  const provasCorridos = ['Office Depot'];
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
