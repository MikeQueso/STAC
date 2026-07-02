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

// Carga variables desde un archivo .env si existe (uso local en PC).
// En GitHub Actions no hay .env y las variables vienen de los Secrets.
try { require('dotenv').config(); } catch (e) {}

const fs = require('fs');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';
const ABASTEO_ENABLED = process.env.ABASTEO_ENABLED === '1';
// Cyberpuerta solo funciona desde una IP residencial (PC en casa), no desde
// servidores. Se activa con CYBERPUERTA_ENABLED=1 en el .env local.
const CYBERPUERTA_ENABLED = process.env.CYBERPUERTA_ENABLED === '1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

// Quita acentos (á→a, ó→o…) antes de normalizar a [a-z0-9], para que "Sólido"
// no se reduzca a "slido" y deje de coincidir con palabras conocidas.
function foldWord(s) {
  return (s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Palabras de categoría/descripción que algunos productos del catálogo ponen
// ANTES de la marca real (ej. "Unidad de Estado Sólido SSD Adata Legend 710",
// "Diadema ASUS...", "Fuente de Poder Naceb..."). Se saltan al buscar la marca
// para no terminar comparando contra "unidad", "diadema" o "fuente".
const CATEGORY_PREFIX = new Set([
  'unidad', 'de', 'estado', 'solido', 'sólido', 'ssd', 'hdd', 'disco',
  'disipador', 'para', 'cpu', 'tarjeta', 'video', 'gráfica', 'grafica', 'madre',
  'memoria', 'ram', 'gabinete', 'gamer', 'impresora', 'multifuncional',
  'mouse', 'teclado', 'procesador', 'fuente', 'poder', 'diadema',
  'ventilador', 'ventiladores', 'audífonos', 'audifonos', 'micrófono',
  'microfono', 'webcam', 'monitor', 'base', 'soporte', 'kit',
  // prefijos comunes en nombres de computadoras de escritorio
  'computadora', 'escritorio', 'mini', 'pc',
]);

// Extrae la "firma" de un producto (marca, modelo clave, capacidades…) una
// sola vez, para reusarla tanto al armar variantes de búsqueda como al
// comparar candidatos.
function extractSignature(productName) {
  const wanted = tokenize(productName);
  const wantedSig = [...new Set(wanted.filter((w) => w.length > 2))];
  const digitToks = wanted.filter((w) => /\d/.test(w));
  // El "modelo clave" debe ser el modelo real (mx500, rm850x, 5600x, 13900k),
  // no una especificación (1tb, 850w, 3200mhz, 7200rpm). Preferimos tokens con
  // letras+dígitos; si no hay, un número puro que no sea unidad (ej. 990).
  const isUnit = (t) => /^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm|bit)$/.test(t) || /^\d+x\d+$/.test(t);
  // Tipos de memoria (gddr6, gddr6x, ddr4, ddr5…) no son el modelo del
  // producto aunque tengan letras+dígitos — si no se excluyen, "RX 6650 XT"
  // con "GDDR6" termina tomando "gddr6" como modelo clave y deja de exigir
  // que el resultado realmente sea un "6650" (acepta cualquier otra GPU con
  // GDDR6, p.ej. una RX 7600).
  const isMemType = (t) => /^g?ddr\d+x?$/.test(t);
  const modelLike = digitToks.filter((t) => /[a-z]/.test(t) && !isUnit(t) && !isMemType(t));
  const pureNum = digitToks.filter((t) => !isUnit(t) && !/[a-z]/.test(t));
  const keyModel = modelLike.sort((a, b) => b.length - a.length)[0]
                || pureNum.sort((a, b) => b.length - a.length)[0] || null;
  const productIsBuild = /comput|laptop|combo|bundle|\bpc\b|\bkit\b/i.test(productName);
  const wantedSet = new Set(wanted);

  // Marca: primera palabra "significativa" del producto (saltando prefijos de
  // categoría como "Unidad de Estado Sólido SSD"), normalizada sin signos. Si
  // es muy corta (MSI, AMD, be...), se concatena la siguiente para precisión.
  const allWords = productName.split(/\s+/);
  let start = 0;
  while (start < allWords.length - 1 && CATEGORY_PREFIX.has(foldWord(allWords[start]))) {
    start++;
  }
  const significantWords = allWords.slice(start);
  const brandIsShort = foldWord(significantWords[0]).length <= 3 && significantWords[1];
  let brand = foldWord(significantWords[0]);
  if (brandIsShort) brand += foldWord(significantWords[1]);
  const brandDisplay = (brandIsShort ? significantWords.slice(0, 2) : significantWords.slice(0, 1)).join(' ');

  // Capacidades (16GB, 1TB…) que el resultado DEBE tener para no confundir
  // 16GB con 8GB, 1TB con 500GB, etc.
  const caps = wanted.filter((w) => /^\d+(gb|tb)$/.test(w));

  // El producto no es un kit de mantenimiento ni RAM de laptop, salvo que su
  // propio nombre lo diga.
  const prodHasBadKind = /mantenim|so-?dimm/i.test(productName);

  return { wanted, wantedSig, wantedSet, keyModel, brand, brandDisplay, caps, productIsBuild, prodHasBadKind };
}

// Variantes de búsqueda, de la más específica a la más amplia. Si la primera
// no trae resultados (o ninguno pasa el comparador), se intenta la siguiente
// — así un producto con un nombre muy largo/descriptivo igual se encuentra
// aunque tarde más. El comparador (pickBestMatch) sigue exigiendo la misma
// marca/modelo/capacidad sin importar qué variante haya traído el candidato.
function buildQueryVariants(productName) {
  const sig = extractSignature(productName);
  const variants = [];
  const add = (q) => { const t = (q || '').trim(); if (t.length >= 2 && !variants.includes(t)) variants.push(t); };

  add(searchQuery(productName));                                  // 1. nombre acortado (actual)
  if (sig.brandDisplay && sig.keyModel) add(`${sig.brandDisplay} ${sig.keyModel}`); // 2. marca + modelo clave
  if (sig.keyModel) add(sig.keyModel);                             // 3. solo el modelo clave
  if (sig.brandDisplay) add(sig.brandDisplay);                     // 4. solo la marca (último recurso)

  return variants;
}

// Prueba cada variante de búsqueda con `searchFn` hasta encontrar un
// candidato que pase pickBestMatch, o se agoten las variantes.
async function searchWithFallback(searchFn, productName, variants) {
  for (const query of variants) {
    const items = await searchFn(query);
    const match = pickBestMatch(productName, items);
    if (match) return match;
  }
  return null;
}

// Elige el resultado que mejor coincide con el nombre del producto.
function pickBestMatch(productName, items) {
  if (!items || !items.length) return null;
  const { wantedSig, wantedSet, keyModel, brand, caps, productIsBuild, prodHasBadKind } = extractSignature(productName);
  const VARIANT_QUALIFIERS = ['ti', 'super', 'pro'];

  let best = null;
  let bestScore = 1;
  for (const item of items) {
    const price = parsePrice(item.price);
    if (price === null || price <= 0) continue;
    const title = item.title || '';
    const titleStr = title.toLowerCase();
    const titleNorm = foldWord(title);
    const tokSet = new Set(tokenize(title));

    if (!productIsBuild && /comput|laptop|combo|bundle/i.test(title)) continue;
    if (!prodHasBadKind && /mantenim|so-?dimm/i.test(title)) continue;
    if (brand && !titleNorm.includes(brand)) continue;       // misma marca
    // Capacidad: comparar contra el título normalizado para aceptar "1 TB" = "1tb".
    if (caps.some((c) => !titleNorm.includes(c))) continue;   // misma capacidad
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
    if (!c || GENERIC.has(c)) return false;
    // Quita tokens de especificación que rompen el buscador (capacidad,
    // potencia, frecuencia, rpm, kits): 1tb, 500gb, 850w, 3200mhz, 7200rpm, 2x8…
    if (/^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm)$/.test(c)) return false;
    if (/^\d+x\d+$/.test(c)) return false;
    if (/^ddr\d$/.test(c) || /^cl\d+$/.test(c)) return false;
    return true;
  });
  const q = kept.join(' ').trim();
  return q.length >= 3 ? q : name;
}

// ─── DD TECH (ddtech.mx · resultados por JS → requiere navegador) ───────────
// `query` ya viene armado por buildQueryVariants() — no construye el suyo,
// para poder probar varias variantes (cascada) desde el llamador.
async function searchDDTech(page, query) {
  const url = `https://ddtech.mx/buscar/${encodeURIComponent(query).replace(/%20/g, '+')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Espera a la tarjeta de producto real (h3.name dentro de .product).
  await page.waitForFunction(() => document.querySelector('.product h3.name'), { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);

  // Tarjeta real de DD Tech: div.product → h3.name (título) + span.price (precio).
  return await page.$$eval('.product', (nodes) =>
    nodes.slice(0, 16).map((n) => ({
      title: (n.querySelector('h3.name, .name')?.textContent || '').trim(),
      price: (n.querySelector('.price, .product-price')?.textContent || '').trim(),
      url: n.querySelector('a[href*="/producto/"]')?.href || ''
    })).filter((x) => x.title)
  ).catch(() => []);
}

// ─── ABASTEO (abasteo.mx · misma plataforma OXID que Cyberpuerta, precios
//     públicos · resultados por JS → requiere navegador) ────────────────────
async function searchAbasteo(page, query) {
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(query)}`;
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

// ─── CYBERPUERTA (HTTP directo · solo funciona desde IP residencial / PC) ──
async function searchCyberpuerta(query) {
  const url = `https://www.cyberpuerta.mx/index.php?cl=search&searchparam=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' } }).catch(() => null);
  if (!res || !res.ok) return [];
  const html = await res.text();
  const names = [];
  const cardRe = /<a href="(\/[^"]+)"\s+class="cp-product-info-dne[^"]*"\s+title="([^"]*)"/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) names.push({ url: 'https://www.cyberpuerta.mx' + m[1], title: m[2] });
  const prices = [];
  const priceRe = /cp-text--price-total[^>]*>(?:<!--\[-->)?\s*\$?\s*([\d,]+(?:\.\d{2})?)/g;
  while ((m = priceRe.exec(html)) !== null) prices.push(m[1]);
  return names.map((n, i) => ({ title: n.title, url: n.url, price: prices[i] || '' }));
}

// ─── OFFICE DEPOT MX (officedepot.com.mx · precios en JSON-LD del HTML →
//     HTTP directo, sin navegador) · útil para tintas/cartuchos ────────────
async function searchOfficeDepot(query) {
  const url = `https://www.officedepot.com.mx/search?text=${encodeURIComponent(query)}`;
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

  const hasAbasteo = ABASTEO_ENABLED;   // precios públicos, no requiere login
  const hasDDTech = true;               // ddtech.mx es público, no requiere login
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
  let conAbasteo = 0, conDD = 0, conOD = 0, conCyber = 0;

  // Construye la URL de búsqueda (fallback cuando no hay match exacto)
  function searchUrlFor(proveedor, query) {
    const q = encodeURIComponent(query);
    if (proveedor === 'DD Tech') return `https://ddtech.mx/buscar/${q.replace(/%20/g, '+')}`;
    if (proveedor === 'Abasteo') return `https://www.abasteo.mx/index.php?cl=search&searchparam=${q}`;
    if (proveedor === 'Office Depot') return `https://www.officedepot.com.mx/search?text=${q}`;
    if (proveedor === 'Cyberpuerta') return `https://www.cyberpuerta.mx/index.php?cl=search&searchparam=${q}`;
    return null;
  }
  // Marca el url como "link de búsqueda" usando precio=null y encontrado_como=null
  function noMatchRow(product, proveedor) {
    const query = searchQuery(product.name);
    return {
      product_id: product.id, proveedor, precio: null,
      url: searchUrlFor(proveedor, query), encontrado_como: null,
      actualizado_at: new Date().toISOString()
    };
  }

  // ── Cyberpuerta (HTTP directo, en paralelo) · solo si está activado (PC en casa) ──
  if (CYBERPUERTA_ENABLED) {
    await mapPool(products, 4, async (product) => {
      try {
        const variants = buildQueryVariants(product.name);
        const match = await searchWithFallback((q) => searchCyberpuerta(q), product.name, variants);
        if (match) {
          conCyber++;
          rows.push({ product_id: product.id, proveedor: 'Cyberpuerta', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
        } else {
          rows.push(noMatchRow(product, 'Cyberpuerta'));
        }
      } catch (e) { console.error(`Cyberpuerta "${product.name}":`, e.message); }
    });
    console.log(`Cyberpuerta: ${conCyber}/${products.length} con precio. (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // ── Office Depot (HTTP directo, en paralelo) · sobre todo tintas ──
  await mapPool(products, 4, async (product) => {
    try {
      const variants = buildQueryVariants(product.name);
      const match = await searchWithFallback((q) => searchOfficeDepot(q), product.name, variants);
      if (match) {
        conOD++;
        rows.push({ product_id: product.id, proveedor: 'Office Depot', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
      } else {
        rows.push(noMatchRow(product, 'Office Depot'));
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
          const variants = buildQueryVariants(product.name);
          const match = await searchWithFallback((q) => searchDDTech(page, q), product.name, variants);
          if (match) {
            conDD++;
            rows.push({ product_id: product.id, proveedor: 'DD Tech', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
          } else {
            rows.push(noMatchRow(product, 'DD Tech'));
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
          const variants = buildQueryVariants(product.name);
          const match = await searchWithFallback((q) => searchAbasteo(page, q), product.name, variants);
          if (match) {
            conAbasteo++;
            rows.push({ product_id: product.id, proveedor: 'Abasteo', precio: match.price, url: match.url, encontrado_como: match.title, actualizado_at: new Date().toISOString() });
          } else {
            rows.push(noMatchRow(product, 'Abasteo'));
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
  if (CYBERPUERTA_ENABLED) provasCorridos.push('Cyberpuerta');
  if (hasDDTech) provasCorridos.push('DD Tech');
  if (hasAbasteo) provasCorridos.push('Abasteo');

  // Salvaguarda: si una corrida produce casi 0 resultados (sitio caído,
  // bloqueo temporal de IP, etc.), NO borramos los precios buenos que ya
  // había — eso dejaría la tabla vacía. Solo borramos+insertamos si el
  // resultado tiene una cobertura mínima razonable.
  const MIN_FRACCION = 0.05; // al menos 5% del catálogo con precio real encontrado
  const rowsConPrecio = rows.filter(r => r.precio !== null && Number(r.precio) > 0);
  if (rowsConPrecio.length < products.length * MIN_FRACCION) {
    console.log(`Cobertura demasiado baja (${rowsConPrecio.length}/${products.length} con precio) — no se borra nada para no perder datos buenos.`);
    return;
  }

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
