// Enriquece la ficha de los productos de reemplazo (los 86 + las 4 GPUs
// reemplazadas) con 3 grupos de tabla de especificaciones, usando el título
// real y completo capturado en precios_abasto.encontrado_como — y QUITA la
// frase "Precio de referencia de mercado..." de la descripción.
try { require('dotenv').config(); } catch (e) {}
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const GPU_REFS_EXTRA = ['ROG-STRIX-RTX4090-O24G', 'GV-N408SAORUS-16GD', 'RTX4070TIS-16G'];

function splitSegments(text) {
  // Solo separa en "/" cuando va rodeado de espacios (separador real entre
  // specs); así no rompe "MB/s" ni números de parte como "SFYR2S/2T0".
  let parts = text.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  return parts;
}

const MARCAS_CONOCIDAS = [
  'Kingston FURY', 'Kingston', 'ADATA XPG', 'Adata', 'Samsung', 'Crucial', 'Seagate', 'WD',
  'Corsair', 'ASUS ROG', 'ASUS TUF', 'ASUS', 'Logitech', 'Redragon', 'AULA', 'Cooler Master',
  'XZEAL', 'Gigabyte', 'MSI', 'Aerocool', 'Naceb', 'ASRock', 'Intel', 'AMD', 'Sapphire',
  'PowerColor', 'HP', 'Canon', 'Epson', 'Brother', 'Razer', 'TeamGroup', 'T-Force', 'Acer',
  'BALAM RUSH', 'Thermaltake', 'Lian Li', 'NZXT', 'Montech', 'Deepcool', 'XPG', 'G.Skill',
  'SteelSeries', 'JBL', 'Sony', 'HyperX', 'Astro', 'be quiet!', 'EVGA', 'Seasonic', 'Antec',
  'ID-Cooling', 'Thermalright', 'ARCTIC',
];
function detectBrand(fullTitle) {
  for (const m of MARCAS_CONOCIDAS) {
    if (fullTitle.toLowerCase().includes(m.toLowerCase())) return m;
  }
  return '';
}

// Etiqueta heurística por categoría — usa pistas léxicas de cada segmento.
function labelFor(category, seg) {
  const s = seg.toLowerCase();
  switch (category) {
    case 'Almacenamiento':
      if (/^\d+\s?(gb|tb)$/.test(s)) return 'Capacidad';
      if (/escritura/.test(s)) return 'Velocidad de escritura';
      if (/lectura/.test(s)) return 'Velocidad de lectura';
      if (/pci\s?e|pci express|nvme/.test(s)) return 'Interfaz / Bus';
      if (/sata/.test(s)) return 'Interfaz';
      if (/m\.2|2\.5|3\.5/.test(s)) return 'Factor de forma';
      if (/rpm/.test(s)) return 'Velocidad de rotación';
      if (/^[a-z0-9/-]+$/i.test(seg) && /\d/.test(seg) && seg.length <= 22) return 'Número de parte';
      break;
    case 'Audífonos':
      if (/met(ro|ros)/.test(s)) return 'Longitud de cable';
      if (/3\.5mm|usb|bluetooth|inal[aá]mbric|al[aá]mbric/.test(s)) return 'Conexión';
      if (/^\d+(\.\d+)?$/.test(s) || /canales|7\.1|5\.1/.test(s)) return 'Canales de audio';
      if (/negro|blanco|rojo|azul|rosa|gris|verde/.test(s)) return 'Color';
      if (/^[a-z0-9-/ ]+$/i.test(seg) && /\d/.test(seg) && seg.length <= 24) return 'Modelo / SKU';
      break;
    case 'Fuente de Poder':
      if (/80\s?\+|80 plus|bronze|gold|platinum|titanium/.test(s)) return 'Certificación de eficiencia';
      if (/^\d+w$/.test(s)) return 'Potencia';
      if (/atx/.test(s)) return 'Estándar / Conectores';
      if (/12vhpwr|pcie/.test(s)) return 'Conector PCIe / 12VHPWR';
      if (/mm$/.test(s)) return 'Tamaño de ventilador';
      break;
    case 'Gabinete':
      if (/atx|itx|tower|micro/.test(s)) return 'Factor de forma compatible';
      if (/cristal|templado|vidrio|malla|mesh|acrílico/.test(s)) return 'Panel lateral';
      if (/ventilador/.test(s)) return 'Ventiladores incluidos';
      if (/negro|blanco|rojo|azul|rosa|gris/.test(s)) return 'Color';
      if (/^[a-z0-9-/ ]+$/i.test(seg) && /\d/.test(seg) && seg.length <= 24) return 'Modelo / SKU';
      break;
    case 'Memoria RAM':
      if (/mt\/s|mhz/.test(s)) return 'Velocidad';
      if (/^cl\d+$/.test(s)) return 'Latencia (CL)';
      if (/xmp|expo/.test(s)) return 'Perfil de overclock';
      if (/rgb/.test(s)) return 'Iluminación';
      if (/negro|blanco|rojo|plata|gris/.test(s)) return 'Color';
      if (/^[a-z0-9-/ ]+$/i.test(seg) && /\d/.test(seg) && seg.length <= 24) return 'Número de parte';
      break;
    case 'Mouse':
      if (/dpi/.test(s)) return 'Sensor (DPI)';
      if (/rgb/.test(s)) return 'Iluminación';
      if (/bot[oó]n/.test(s)) return 'Botones programables';
      if (/usb|inal[aá]mbric|al[aá]mbric|bluetooth/.test(s)) return 'Conexión';
      if (/negro|blanco|rojo|gris|rosa/.test(s)) return 'Color';
      break;
    case 'Placa Madre':
      if (/hdmi|displayport|\bdp\b/.test(s)) return 'Salidas de video';
      if (/atx|itx|micro/.test(s)) return 'Factor de forma';
      if (/lga|am4|am5|socket/.test(s)) return 'Socket';
      if (/ddr/.test(s)) return 'Memoria soportada';
      if (/h610|b550|b650|b760|x670|z790|chipset/.test(s)) return 'Chipset / Plataforma';
      if (/^(intel|amd)$/.test(s.trim()) || /para intel$|para amd$/.test(s)) return 'Plataforma';
      break;
    case 'Procesador':
      if (/n[uú]cleo/.test(s)) return 'Núcleos';
      if (/ghz/.test(s)) return 'Frecuencia';
      if (/cach[ée]/.test(s)) return 'Memoria caché';
      if (/gr[aá]ficos/.test(s)) return 'Gráficos integrados';
      if (/lga|am4|am5|socket/.test(s)) return 'Socket';
      if (/disipador/.test(s)) return 'Disipador incluido';
      break;
    case 'Refrigeración':
      if (/mm$/.test(s)) return 'Tamaño de ventilador';
      if (/rpm/.test(s)) return 'Velocidad máxima';
      if (/negro|blanco|rgb|argb/.test(s)) return 'Color / Iluminación';
      break;
    case 'Tinta de impresora':
      if (/p[aá]gina/.test(s)) return 'Rendimiento estimado';
      if (/negro|tricolor|cyan|magenta|amarillo|cian/.test(s)) return 'Color de tinta';
      break;
    case 'Tarjeta Gráfica':
      if (/gb$/.test(s) && /gddr/i.test(seg)) return 'Memoria de video';
      if (/gddr/.test(s)) return 'Tipo de memoria';
      if (/pci express|pcie/.test(s)) return 'Interfaz';
      break;
  }
  if (/^\d+\s?(gb|tb)$/.test(s)) return 'Capacidad';
  if (/negro|blanco|rojo|azul|gris|rosa|plata|verde/.test(s) && seg.length < 20) return 'Color';
  return 'Especificación';
}

function buildFicha(category, displayName, _brandIgnored, fullTitle) {
  const brand = detectBrand(fullTitle) || detectBrand(displayName);
  const segs = splitSegments(fullTitle).filter((s) => s.toLowerCase() !== displayName.toLowerCase());
  const seen = new Set();
  const tecFeatures = [];
  for (const seg of segs) {
    const v = seg.trim();
    if (!v || v.length > 70 || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    tecFeatures.push({ name: labelFor(category, v), value: v });
  }
  if (!tecFeatures.length) tecFeatures.push({ name: 'Descripción', value: displayName });

  const generalFeatures = [
    { name: 'Marca', value: brand || '—' },
    { name: 'Categoría', value: category },
    { name: 'Condición', value: 'Nuevo, en caja sellada' },
    { name: 'Disponibilidad', value: 'Stock en STAC' },
  ];

  const garantiaFeatures = [
    { name: 'Garantía', value: 'Garantía directa de fábrica del fabricante' },
    { name: 'Empaque', value: 'Empaque y accesorios originales de fábrica' },
    { name: 'Soporte', value: 'Soporte y seguimiento postventa con STAC' },
    { name: 'Facturación', value: 'Factura disponible a solicitud' },
  ];

  const specsGroups = [
    { name: 'Especificaciones Técnicas', features: tecFeatures },
    { name: 'Información General', features: generalFeatures },
    { name: 'Garantía y Contenido', features: garantiaFeatures },
  ];

  const specsFlat = specsGroups.map((g) => `${g.name}:\n` + g.features.map((f) => `  ${f.name}: ${f.value}`).join('\n')).join('\n\n');

  const description_html =
    `<p><strong>${displayName}</strong></p>` +
    `<p>${category} ${brand ? 'de ' + brand + ' ' : ''}disponible en STAC, nuevo y sellado de fábrica. ` +
    `Revisa abajo la ficha técnica completa con todas las especificaciones del fabricante.</p>`;

  return { specsGroups, specsFlat, description_html };
}

async function run() {
  const { data: withRef, error } = await sb.from('products').select('id, name, category, ref');
  if (error) { console.error(error.message); process.exit(1); }
  const targets = withRef.filter((p) => /-R\d{3}$/.test(p.ref || '') || GPU_REFS_EXTRA.includes(p.ref));

  const { data: precios } = await sb.from('precios_abasto').select('product_id, encontrado_como');
  const byId = {};
  for (const r of precios) if (!byId[r.product_id]) byId[r.product_id] = r.encontrado_como;

  let ok = 0, fail = 0;
  for (const p of targets) {
    const fullTitle = byId[p.id] || p.name;
    const ficha = buildFicha(p.category, p.name, null, fullTitle);
    const brand = detectBrand(fullTitle) || detectBrand(p.name);
    const { error: ue } = await sb.from('products').update({
      description_html: ficha.description_html,
      description: ficha.specsFlat,
      specs: ficha.specsFlat,
      specs_json: JSON.stringify(ficha.specsGroups),
      brand: brand || null,
      brand_info: brand || null,
    }).eq('id', p.id);
    if (ue) { console.log(`✘ ${p.name}: ${ue.message}`); fail++; continue; }
    ok++;
  }
  console.log(`\nEnriquecidos: ${ok} | Fallos: ${fail} | Total: ${targets.length}`);
}

module.exports = { buildFicha, splitSegments, labelFor, detectBrand, run };
if (require.main === module) run();
