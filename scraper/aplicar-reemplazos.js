// Aplica los reemplazos: crea los productos nuevos (imagen en Storage + ficha +
// precio) y borra los viejos sin precio. Lee reemplazos-candidatos.json y el
// respaldo respaldo-sin-precio-*.json. Idempotencia: marca ref con sufijo -R.
try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SUPA_HOST = process.env.SUPABASE_URL.replace(/^https?:\/\//, '');
const BUCKET = 'productos';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DRY = process.argv.includes('--dry');
const CAT_ARG = (process.argv.find((a) => a.startsWith('--cat=')) || '').replace('--cat=', '');

const PREFIX = {
  'Almacenamiento': 'ALM', 'Audífonos': 'AUD', 'Fuente de Poder': 'PSU',
  'Gabinete': 'GAB', 'Impresoras': 'IMP', 'Memoria RAM': 'RAM', 'Mouse': 'MOU',
  'Placa Madre': 'MB', 'Procesador': 'CPU', 'Refrigeración': 'ACFRE',
  'Tarjeta Gráfica': 'GPU', 'Tinta de impresora': 'TIN',
  'Computadoras ya armadas': 'PC',
};

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// Etiqueta heuristica para un segmento de especificacion.
function labelFor(seg) {
  const s = seg.toLowerCase();
  if (/\d+\s?(gb|tb)\b/.test(s)) return 'Capacidad';
  if (/\d+\s?w\b|80\s?plus|bronze|gold|platinum/.test(s)) return 'Potencia / Certificación';
  if (/\d+\s?mhz|ddr\d|cl\d+/.test(s)) return 'Frecuencia / Tipo';
  if (/atx|itx|tower|micro/.test(s)) return 'Factor de forma';
  if (/rgb|argb|iluminaci/.test(s)) return 'Iluminación';
  if (/cristal|templado|vidrio|malla|mesh/.test(s)) return 'Panel / Material';
  if (/ventilador|fan/.test(s)) return 'Ventiladores';
  if (/wi-?fi|bluetooth|usb|hdmi|inalambric/.test(s)) return 'Conectividad';
  if (/negro|blanco|gris|color/.test(s)) return 'Color';
  if (/nvme|sata|m\.2|pcie/.test(s)) return 'Interfaz';
  if (/rpm/.test(s)) return 'Velocidad';
  if (/paginas|páginas|ppm|dpi/.test(s)) return 'Rendimiento';
  return 'Especificación';
}

function buildFicha(fullName, category, price, proveedor) {
  const segs = fullName.split('/').map((s) => s.trim()).filter(Boolean);
  const display = segs[0] || fullName;
  const brand = (display.replace(/^(gabinete|fuente de poder|memoria ram|tarjeta madre|tarjeta de video|procesador|disipador|audifonos?|mouse|impresora|cartucho|botella|toner|t[oó]ner|computadora)\s*(gamer|de poder|ram|de escritorio)?\s*/i, '').split(/\s+/)[0]) || '';

  const features = [];
  const seen = new Set();
  for (const seg of segs.slice(1)) {
    // separa sub-segmentos pegados por " - " o multiples /
    for (const part of seg.split(/\s+-\s+/)) {
      const v = part.trim();
      if (!v || v.length > 60 || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      features.push({ name: labelFor(v), value: v });
    }
  }
  if (!features.length) features.push({ name: 'Descripción', value: display });

  const specsGroups = [{ name: 'Especificaciones', features }];
  const specsFlat = features.map((f) => `${f.name}: ${f.value}`).join('\n');
  const description_html =
    `<p><strong>${display}</strong></p>` +
    `<p>${category} disponible en STAC. Producto nuevo, original y sellado.</p>` +
    `<p>Precio de referencia de mercado (${proveedor}): $${price.toLocaleString('es-MX')} MXN. ` +
    `Consulta el precio final de venta con nosotros.</p>`;

  return { display, brand, description_html, specs: specsFlat, specs_json: JSON.stringify(specsGroups), brand_info: brand };
}

async function uploadImage(id, url) {
  if (url && url.startsWith('/')) url = 'https://www.officedepot.com.mx' + url; // red de seguridad
  const res = await fetch(url, { headers: { 'User-Agent': UA } }).catch(() => null);
  if (!res || !res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) return null;
  const ext = extFromType(ct, url);
  const path = `${id}/0.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType: ct || ('image/' + ext), upsert: true });
  if (up.error) return null;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

(async () => {
  const cand = JSON.parse(fs.readFileSync('reemplazos-candidatos.json', 'utf8'));
  const respFile = fs.readdirSync('.').filter((f) => /^respaldo-sin-precio-.*\.json$/.test(f)).sort().pop();
  const viejos = JSON.parse(fs.readFileSync(respFile, 'utf8'));
  console.log(`Respaldo: ${respFile} (${viejos.length} a borrar)`);

  // Mapa categoria → ids viejos
  const viejosPorCat = {};
  for (const v of viejos) (viejosPorCat[v.category] = viejosPorCat[v.category] || []).push(v.id);

  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  let creados = 0, fallos = 0, borrados = 0;
  const idsViejosABorrar = [];

  for (const [cat, list] of Object.entries(cand)) {
    if (CAT_ARG && cat !== CAT_ARG) continue;                    // procesar solo una categoria
    const refBase = PREFIX[cat] || 'STAC';
    let n = 1;
    let creadosCat = 0;
    for (const c of list) {
      const id = crypto.randomUUID();
      const ficha = buildFicha(c.name, cat, c.price, c.proveedor);
      if (DRY) { console.log(`[DRY] ${cat}  ${ficha.display}  $${c.price}  img:${c.image ? 'si' : 'NO'}`); creados++; creadosCat++; continue; }

      const imgUrl = await uploadImage(id, c.image);
      if (!imgUrl) { console.log(`  ✘ sin imagen, salto: ${ficha.display}`); fallos++; continue; }

      const row = {
        id, name: ficha.display, category: cat, price: c.price, old_price: null,
        ref: `${refBase}-R${String(n).padStart(3, '0')}`, images: [imgUrl],
        brand: ficha.brand, description: ficha.specs, description_html: ficha.description_html,
        specs: ficha.specs, specs_json: ficha.specs_json, brand_info: ficha.brand_info, stock: 10,
      };
      const ins = await sb.from('products').insert(row);
      if (ins.error) { console.log(`  ✘ insert falló (${ficha.display}): ${ins.error.message}`); fallos++; continue; }

      await sb.from('precios_abasto').insert({
        product_id: id, proveedor: c.proveedor, precio: c.price, url: c.url,
        encontrado_como: c.name, actualizado_at: new Date().toISOString(),
      });
      n++; creados++; creadosCat++;
    }
    // Borra tantos viejos de esta categoria como reemplazos creamos.
    const viejosCat = viejosPorCat[cat] || [];
    for (let i = 0; i < creadosCat && i < viejosCat.length; i++) idsViejosABorrar.push(viejosCat[i]);
    console.log(`${cat}: creados ${creadosCat}, marcados para borrar ${Math.min(creadosCat, viejosCat.length)}`);
  }

  if (!DRY && idsViejosABorrar.length) {
    await sb.from('precios_abasto').delete().in('product_id', idsViejosABorrar);
    const del = await sb.from('products').delete().in('id', idsViejosABorrar);
    if (del.error) console.log('Error al borrar viejos:', del.error.message);
    else borrados = idsViejosABorrar.length;
  }

  console.log(`\nCreados: ${creados} | Fallos: ${fallos} | Borrados viejos: ${borrados}`);
})();
