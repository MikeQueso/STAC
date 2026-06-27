// STAC · Aplica las fichas técnicas (redactadas a mano) a la base de datos.
//
// Lee todos los archivos scraper/fichas/*.json (cada uno es un objeto
// { "Nombre exacto del producto": { brandInfo, descriptionSections, specsGroups } })
// y actualiza products.description_html / specs_json / specs / brand_info,
// emparejando por NOMBRE exacto.
//
// Requiere (Secrets en GitHub): SUPABASE_URL, SUPABASE_SERVICE_KEY

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !KEY) { console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY.'); process.exit(1); }
const sb = createClient(SUPABASE_URL, KEY);

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildDescHtml(sections) {
  if (!sections || !sections.length) return null;
  return sections.map(s => `<p><strong>${esc(s.title)}</strong></p><p>${esc(s.body)}</p>`).join('');
}

async function run() {
  const dir = path.join(__dirname, 'fichas');
  if (!fs.existsSync(dir)) { console.error('No existe la carpeta fichas/'); process.exit(1); }
  const data = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try { Object.assign(data, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
    catch (e) { console.error(`JSON inválido en ${f}:`, e.message); process.exit(1); }
  }
  const names = Object.keys(data);
  console.log(`Fichas redactadas: ${names.length}`);

  const { data: products, error } = await sb.from('products').select('id,name');
  if (error) { console.error('No se pudo leer products:', error.message); process.exit(1); }
  const byName = {};
  products.forEach(p => { byName[p.name] = p; });

  let upd = 0, miss = 0;
  for (const name of names) {
    const p = byName[name];
    if (!p) { console.log('⚠ No existe en la base:', name); miss++; continue; }
    const d = data[name];
    const payload = {};
    const descHtml = buildDescHtml(d.descriptionSections);
    if (descHtml) payload.description_html = descHtml;
    if (d.specsGroups && d.specsGroups.length) {
      payload.specs_json = JSON.stringify(d.specsGroups);
      payload.specs = d.specsGroups.flatMap(g => (g.features || []).map(f => `${f.name}: ${f.value}`)).join('\n');
    }
    if (d.brandInfo) payload.brand_info = d.brandInfo;
    if (Object.keys(payload).length) {
      const { error: ue } = await sb.from('products').update(payload).eq('id', p.id);
      if (ue) console.error('✗ Falló', name, ue.message); else upd++;
    }
  }
  console.log(`Actualizados: ${upd} | No encontrados en la base: ${miss}`);
}

run();
