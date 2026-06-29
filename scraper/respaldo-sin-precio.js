// Respalda a JSON los productos SIN precio (los 86) antes de reemplazarlos.
try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data: products, error: e1 } = await sb.from('products').select('*');
  if (e1) { console.error(e1.message); process.exit(1); }
  const { data: precios } = await sb.from('precios_abasto').select('product_id, precio');

  const conPrecio = new Set();
  for (const r of precios || []) if (r.precio != null && Number(r.precio) > 0) conPrecio.add(r.product_id);

  const sinPrecio = products.filter((p) => !conPrecio.has(p.id));
  const file = `respaldo-sin-precio-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(file, JSON.stringify(sinPrecio, null, 2), 'utf8');

  const porCat = {};
  for (const p of sinPrecio) porCat[p.category] = (porCat[p.category] || 0) + 1;
  console.log(`Respaldados ${sinPrecio.length} productos en ${file}`);
  console.log('Por categoria:');
  for (const c of Object.keys(porCat).sort()) console.log(`   ${porCat[c]}  ${c}`);
})();
