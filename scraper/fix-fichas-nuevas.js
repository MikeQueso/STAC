// Corrige la ficha de los 31 productos nuevos (Ventiladores + Computadoras)
// para que el primer segmento del título (marca/modelo, ya mostrado como
// nombre del producto) no se repita como una característica más.
try { require('dotenv').config(); } catch (e) {}
const { createClient } = require('@supabase/supabase-js');
const { buildFicha, detectBrand } = require('./enriquecer-reemplazos.js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data } = await sb.from('products').select('id,name,category,ref')
    .or('category.eq.Ventiladores,category.eq.Computadoras ya armadas');
  console.log('A corregir:', data.length);

  let ok = 0;
  for (const p of data) {
    const firstSeg = p.name.split(/\s+\/\s+/)[0].split(',')[0].trim();
    const brand = detectBrand(p.name);
    const ficha = buildFicha(p.category, firstSeg, null, p.name);
    const { error } = await sb.from('products').update({
      description_html: ficha.description_html,
      description: ficha.specsFlat,
      specs: ficha.specsFlat,
      specs_json: JSON.stringify(ficha.specsGroups),
      brand, brand_info: brand,
    }).eq('id', p.id);
    if (error) { console.log('✘', p.name, error.message); continue; }
    ok++;
  }
  console.log('Corregidos:', ok);
})();
