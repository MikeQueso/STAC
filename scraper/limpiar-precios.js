const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

function extractBrand(productName) {
  const allWords = productName.split(/\s+/);
  let start = 0;
  while (start < allWords.length - 1 && CATEGORY_PREFIX.has(foldWord(allWords[start]))) start++;
  const significantWords = allWords.slice(start);
  const brandIsShort = foldWord(significantWords[0]).length <= 3 && significantWords[1];
  let brand = foldWord(significantWords[0]);
  if (brandIsShort) brand += foldWord(significantWords[1]);
  return brand;
}

(async () => {
  // 1. Eliminar productos con accesorios en el nombre
  const { data: allProds, error: pe } = await sb.from('products').select('id,name').eq('category', 'Computadoras ya armadas');
  if (pe) { console.error('Error leyendo productos:', pe.message); return; }

  const toDelete = allProds.filter(p =>
    /\+\s*(Teclado|Mouse|Monitor)/i.test(p.name) || /Monitor\s+\d+/i.test(p.name)
  );
  const deleteIds = toDelete.map(p => p.id);

  if (deleteIds.length) {
    const { error: de } = await sb.from('products').delete().in('id', deleteIds);
    if (de) console.error('Error eliminando productos:', de.message);
    else {
      console.log(`Eliminados ${deleteIds.length} productos con accesorios:`);
      toDelete.forEach(p => console.log(' -', p.name));
    }
  }

  // 2. Auditar precios_abasto — detectar y borrar matches con marca incorrecta
  const { data: products } = await sb.from('products').select('id,name');
  const { data: precios } = await sb.from('precios_abasto').select('id,product_id,proveedor,encontrado_como,url,precio');

  const byId = {};
  (products || []).forEach(p => { byId[p.id] = p; });

  const wrongIds = [];
  for (const r of (precios || [])) {
    const prod = byId[r.product_id];
    if (!prod || !r.encontrado_como) continue;
    const brand = extractBrand(prod.name);
    if (!brand || brand.length <= 2) continue;
    const titleNorm = foldWord(r.encontrado_como);
    if (!titleNorm.includes(brand)) {
      wrongIds.push(r.id);
      console.log(`\nFALSO [${r.proveedor}]`);
      console.log('  Producto:', prod.name);
      console.log('  Encontrado:', r.encontrado_como);
      console.log('  Marca esperada:', brand);
    }
  }

  if (wrongIds.length) {
    const { error: we } = await sb.from('precios_abasto').delete().in('id', wrongIds);
    if (we) console.error('Error eliminando falsos:', we.message);
    else console.log(`\nEliminados ${wrongIds.length} registros falsos de precios_abasto`);
  } else {
    console.log('\nNo se encontraron registros falsos en precios_abasto');
  }

  console.log('\nListo.');
})();
