// enriquecer-abasteo.js
// Abre cada página de producto en Abasteo (usando el login de distribuidor) y
// extrae imagen principal, descripción y especificaciones técnicas para actualizar
// los productos en Supabase.
//
// Uso local:  node enriquecer-abasteo.js
// Variables:  SUPABASE_URL, SUPABASE_SERVICE_KEY, ABASTEO_USER, ABASTEO_PASS
//
// El script SOLO actualiza campos que están vacíos en Supabase; no sobreescribe
// fichas que ya tienen description_html o specs_json.

try { require('dotenv').config(); } catch (e) {}

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}
// Login opcional: la descripción y especificaciones son públicas; la cuenta
// de distribuidor solo cambia los precios mostrados.
const HAY_LOGIN = !!(process.env.ABASTEO_USER && process.env.ABASTEO_PASS);

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Reutilizado del scraper de precios
const CATEGORY_PREFIX = new Set([
  'unidad','de','estado','solido','sólido','ssd','hdd','disco',
  'disipador','para','cpu','tarjeta','video','gráfica','grafica','madre',
  'memoria','ram','gabinete','gamer','impresora','multifuncional',
  'mouse','teclado','procesador','fuente','poder','diadema',
  'ventilador','ventiladores','audífonos','audifonos','micrófono',
  'microfono','webcam','monitor','base','soporte','kit',
  'computadora','escritorio','mini','pc',
]);

function foldWord(s) {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractBrand(name) {
  const words = name.split(/\s+/);
  let start = 0;
  while (start < words.length - 1 && CATEGORY_PREFIX.has(foldWord(words[start]))) start++;
  const sig = words.slice(start);
  const short = foldWord(sig[0]).length <= 3 && sig[1];
  let brand = foldWord(sig[0]);
  if (short) brand += foldWord(sig[1]);
  return brand;
}

function searchQuery(name) {
  const GENERIC = new Set(['ssd','sata','nvme','hdd','m.2','m2','modular','plus','gold','bronze','platinum','white','80+','para','con','de','la','el','set','toner','cartucho','tinta','original']);
  const kept = name.split(/\s+/).filter(w => {
    const c = w.toLowerCase().replace(/[.,()]/g, '');
    if (!c || GENERIC.has(c)) return false;
    if (/^\d+(gb|tb|mb|w|mhz|ghz|rpm|hz|mm)$/.test(c)) return false;
    if (/^\d+x\d+$/.test(c)) return false;
    if (/^ddr\d$/.test(c) || /^cl\d+$/.test(c)) return false;
    return true;
  });
  const q = kept.join(' ').trim();
  return q.length >= 3 ? q : name;
}

async function loginAbasteo(page) {
  await page.goto('https://www.abasteo.mx/index.php?cl=login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[name="lgn_usr"]', { timeout: 8000 }).catch(() => {});
  await page.fill('input[name="lgn_usr"]', process.env.ABASTEO_USER);
  await page.fill('input[name="lgn_pwd"]', process.env.ABASTEO_PASS);
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForTimeout(2500);
  const loggedIn = await page.$('.c-account, [class*="account"], a[href*="mi-cuenta"]').catch(() => null);
  if (loggedIn) console.log('✓ Abasteo: login exitoso');
  else console.warn('⚠ Abasteo: login posiblemente fallido');
}

// Busca en Abasteo y devuelve la URL de la página del primer resultado que
// coincida con la marca del producto.
async function findAbasteoUrl(page, product) {
  const query = searchQuery(product.name);
  const url = `https://www.abasteo.mx/index.php?cl=search&searchparam=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.c-product-card', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);

  const cards = await page.$$eval('.c-product-card', nodes =>
    nodes.slice(0, 10).map(n => ({
      title: (n.querySelector('.c-product-pic__product-img')?.getAttribute('alt') || '').trim(),
      url: n.querySelector('a.c-product-pic__link, a[href*="/producto/"], a[href*="/Articulo/"]')?.href || ''
    }))
  ).catch(() => []);

  const brand = extractBrand(product.name);
  for (const card of cards) {
    if (!card.url) continue;
    if (brand && brand.length > 2 && !foldWord(card.title).includes(brand)) continue;
    return card.url;
  }
  // Si no hay coincidencia de marca, tomar el primero que tenga URL
  return cards.find(c => c.url)?.url || null;
}

// Extrae datos de enriquecimiento de la página de producto de Abasteo.
async function scrapeProductPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);

  return await page.evaluate(() => {
    const result = {};

    // ── Descripción larga (selector vigente jul-2026: .c-details__long-description) ──
    const descEl = document.querySelector(
      '.c-details__long-description, .c-product-detail__description, .product-description'
    );
    if (descEl) {
      const lines = descEl.innerText.split('\n').map(l => l.trim().replace(/\s+/g, ' ')).filter(l => l.length > 2);
      if (lines[0] && /detalles del producto/i.test(lines[0])) lines.shift();
      if (lines.length) {
        result.description = lines.join(' ').slice(0, 400);
        // Líneas cortas EN MAYÚSCULAS son títulos de sección del fabricante
        result.descriptionHtml = lines.map(l =>
          (l.length < 80 && l === l.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(l))
            ? `<p class="pd-section-title">${l}</p>`
            : `<p>${l}</p>`
        ).join('');
      }
    }

    // ── Especificaciones técnicas (selector vigente: [class*=attribute] table) ──
    const specsTable = document.querySelector(
      '[class*="attribute"] table, .c-product-detail__specs table, .product-specs table, [class*="specs"] table, table.table'
    );
    const specsGroups = [];

    if (specsTable) {
      // Formato tabla: busca filas <tr> con <th> o <td>
      let currentGroup = null;
      specsTable.querySelectorAll('tr').forEach(row => {
        const cells = row.querySelectorAll('th, td');
        if (cells.length === 1) {
          // Encabezado de grupo
          const groupName = cells[0].textContent.trim();
          if (groupName) {
            currentGroup = { name: groupName, features: [] };
            specsGroups.push(currentGroup);
          }
        } else if (cells.length >= 2) {
          const name = cells[0].textContent.trim();
          const value = cells[1].textContent.trim();
          if (name && value) {
            if (!currentGroup) { currentGroup = { name: 'Especificaciones', features: [] }; specsGroups.push(currentGroup); }
            currentGroup.features.push({ name, value });
          }
        }
      });
    } else {
      // Formato lista: dl > dt + dd, o ul > li con ":"
      const dl = document.querySelector('.c-product-detail__specs dl, [class*="specs"] dl');
      if (dl) {
        const group = { name: 'Especificaciones', features: [] };
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        dts.forEach((dt, i) => {
          const name = dt.textContent.trim();
          const value = dds[i] ? dds[i].textContent.trim() : '';
          if (name && value) group.features.push({ name, value });
        });
        if (group.features.length) specsGroups.push(group);
      } else {
        // Último recurso: buscar cualquier lista con pares clave: valor
        const listItems = document.querySelectorAll('.c-product-detail__specs li, [class*="specs"] li');
        if (listItems.length) {
          const group = { name: 'Especificaciones', features: [] };
          listItems.forEach(li => {
            const text = li.textContent.trim();
            const idx = text.indexOf(':');
            if (idx > 0) {
              group.features.push({ name: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() });
            }
          });
          if (group.features.length) specsGroups.push(group);
        }
      }
    }

    if (specsGroups.length) result.specsGroups = specsGroups;

    return result;
  });
}

async function run() {
  // Carga todos los productos y sus registros de Abasteo
  const { data: products, error: pe } = await sb.from('products')
    .select('id, name, brand, description, description_html, specs_json, images');
  if (pe) { console.error('Error leyendo products:', pe.message); process.exit(1); }

  const { data: precios } = await sb.from('precios_abasto')
    .select('product_id, url, encontrado_como')
    .eq('proveedor', 'Abasteo')
    .not('url', 'like', '%cl=search%'); // solo URLs de páginas de producto, no de búsqueda

  const urlByProduct = {};
  (precios || []).forEach(r => { if (r.url) urlByProduct[r.product_id] = r.url; });

  // Ficha "pobre": sin descripción, descripción corta o con menos de 4 specs.
  const featuresCount = (specsJson) => {
    try { return JSON.parse(specsJson || '[]').reduce((s, g) => s + ((g.features || []).length), 0); }
    catch { return 0; }
  };
  // --todo: procesa TODOS los productos con página de proveedor conocida (las
  // reglas de "solo sobrescribir si lo nuevo es mejor" siguen aplicando).
  const TODO = process.argv.includes('--todo');
  const toEnrich = TODO
    ? products.filter(p => urlByProduct[p.id])
    : products.filter(p =>
        !p.description_html || p.description_html.length < 250 || featuresCount(p.specs_json) < 4
      );

  console.log(`\nProductos a enriquecer (ficha pobre): ${toEnrich.length} de ${products.length}`);
  if (!toEnrich.length) { console.log('Todos los productos ya tienen ficha completa.'); return; }

  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  if (HAY_LOGIN) await loginAbasteo(page);
  else console.log('Sin credenciales de Abasteo — usando páginas públicas (la ficha es la misma).');

  let enriched = 0, skipped = 0, failed = 0;
  const failedList = [];

  for (let i = 0; i < toEnrich.length; i++) {
    const product = toEnrich[i];
    console.log(`\n[${i + 1}/${toEnrich.length}] ${product.name}`);

    let productUrl = urlByProduct[product.id] || null;

    // Si no tenemos URL exacta, buscar en Abasteo
    if (!productUrl) {
      console.log('  → Buscando en Abasteo...');
      productUrl = await findAbasteoUrl(page, product).catch(e => {
        console.warn('  ✕ Error buscando:', e.message);
        return null;
      });
    }

    if (!productUrl) {
      console.log('  ○ No encontrado en Abasteo — omitiendo');
      skipped++;
      continue;
    }

    console.log('  → Página:', productUrl);

    let data;
    try {
      data = await scrapeProductPage(page, productUrl);
    } catch (e) {
      console.warn('  ✕ Error raspando página:', e.message);
      failed++;
      failedList.push(product.name);
      continue;
    }

    const update = {};

    // Sobrescribir SOLO si lo nuevo es claramente mejor que lo guardado
    const oldDescLen = (product.description_html || '').length;
    if (data.descriptionHtml && data.descriptionHtml.length > Math.max(250, oldDescLen)) {
      update.description_html = data.descriptionHtml;
      if (data.description) update.description = data.description;
    }

    const featuresCount = (specsJson) => {
      try { return JSON.parse(specsJson || '[]').reduce((s, g) => s + ((g.features || []).length), 0); }
      catch { return 0; }
    };
    const nuevasFeatures = (data.specsGroups || []).reduce((s, g) => s + ((g.features || []).length), 0);
    if (nuevasFeatures > Math.max(3, featuresCount(product.specs_json))) {
      update.specs_json = JSON.stringify(data.specsGroups);
      // También construir specs texto plano para retrocompatibilidad
      const specLines = data.specsGroups.flatMap(g =>
        (g.features || []).map(f => `${f.name}: ${f.value}`)
      );
      update.specs = specLines.join('\n');
    }

    if (Object.keys(update).length === 0) {
      console.log('  ○ Sin datos nuevos extraídos');
      skipped++;
      continue;
    }

    const { error: ue } = await sb.from('products').update(update).eq('id', product.id);
    if (ue) {
      console.warn('  ✕ Error guardando:', ue.message);
      failed++;
      failedList.push(product.name);
    } else {
      const fields = Object.keys(update).join(', ');
      console.log(`  ✓ Actualizado: ${fields}`);
      enriched++;
    }

    // Pausa para no saturar el servidor
    await page.waitForTimeout(800);
  }

  await browser.close();

  console.log(`\n──────────────────────────────────`);
  console.log(`✓  Enriquecidos:  ${enriched}`);
  console.log(`○  Sin datos:     ${skipped}`);
  console.log(`✕  Con error:     ${failed}`);
  if (failedList.length) {
    console.log('\nFallidos:');
    failedList.forEach(n => console.log('  -', n));
  }
}

run().catch(e => { console.error('Error fatal:', e); process.exit(1); });
