// STAC · Migración única de imágenes de producto a Supabase Storage
//
// Descarga cada imagen (Amazon, Best Buy, etc.) y la re-sube al bucket
// público `productos` de tu Supabase, luego actualiza products.images para
// que apunten ahí. Así las fotos sí se pueden incrustar en el PDF (las URLs
// de Supabase permiten CORS; muchas CDNs externas no).
//
// Es idempotente: las que ya estén en Supabase se saltan. Si una descarga
// falla, conserva la URL original (no rompe nada).
//
// Requiere (Secrets en GitHub): SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'productos';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

if (!SUPABASE_URL || !KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, KEY);
const SUPA_HOST = SUPABASE_URL.replace(/^https?:\/\//, '');

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp|gif)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

async function run() {
  // Crear/asegurar bucket público
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  await sb.storage.updateBucket(BUCKET, { public: true }).catch(() => {});

  const { data: products, error } = await sb.from('products').select('id, name, images');
  if (error) { console.error('No se pudo leer products:', error.message); process.exit(1); }
  console.log(`Catálogo: ${products.length} productos.`);

  let migr = 0, skip = 0, fail = 0, rows = 0;

  for (const p of products) {
    const imgs = Array.isArray(p.images) ? p.images : [];
    if (!imgs.length) continue;
    const out = [];
    let changed = false;

    for (let i = 0; i < imgs.length; i++) {
      const url = imgs[i];
      if (!url) continue;
      if (url.includes(SUPA_HOST)) { out.push(url); skip++; continue; } // ya migrada
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) { out.push(url); fail++; continue; }
        const ct = res.headers.get('content-type') || '';
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500) { out.push(url); fail++; continue; } // placeholder/roto
        const ext = extFromType(ct, url);
        const path = `${p.id}/${i}.${ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, buf, {
          contentType: ct || ('image/' + ext), upsert: true
        });
        if (up.error) { out.push(url); fail++; continue; }
        out.push(sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
        migr++; changed = true;
      } catch (e) {
        out.push(url); fail++;
      }
    }

    if (changed) {
      const { error: ue } = await sb.from('products').update({ images: out }).eq('id', p.id);
      if (ue) console.error(`No se pudo actualizar "${p.name}":`, ue.message);
      else rows++;
    }
  }

  console.log(`Migradas: ${migr} | Ya estaban: ${skip} | Fallaron: ${fail} | Productos actualizados: ${rows}`);
}

run();
