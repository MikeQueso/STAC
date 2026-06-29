// Lista los productos que NO tienen precio en NINGUNA tienda, agrupados por categoria.
try { require('dotenv').config(); } catch (e) {}
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data: products, error: e1 } = await sb
    .from('products')
    .select('id, name, category, price');
  if (e1) { console.error('products:', e1.message); process.exit(1); }

  const { data: precios, error: e2 } = await sb
    .from('precios_abasto')
    .select('product_id, proveedor, precio');
  if (e2) { console.error('precios:', e2.message); process.exit(1); }

  const conPrecio = new Set();
  for (const r of precios) {
    if (r.precio != null && Number(r.precio) > 0) conPrecio.add(r.product_id);
  }

  const sinPrecio = products.filter((p) => !conPrecio.has(p.id));

  // Agrupar por categoria
  const porCat = {};
  for (const p of sinPrecio) {
    const c = p.category || '(sin categoria)';
    (porCat[c] = porCat[c] || []).push(p);
  }

  console.log(`TOTAL productos: ${products.length}`);
  console.log(`CON precio (al menos 1 tienda): ${conPrecio.size}`);
  console.log(`SIN precio: ${sinPrecio.length}`);
  console.log('');
  for (const cat of Object.keys(porCat).sort()) {
    console.log(`### ${cat}  (${porCat[cat].length} sin precio)`);
    for (const p of porCat[cat]) console.log(`   - ${p.name}`);
    console.log('');
  }
})();
