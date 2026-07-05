// Barrido único: elimina de products.images los banners que se colaron.
// Detección: un mismo archivo (mismo content-length exacto) repetido en 4+
// productos distintos es un banner del sitio, no una foto del producto
// (las fotos reales son únicas de cada producto). También elimina SVGs.
// Solo toca productos cuyas imágenes vienen del mejorador (?v= en la URL).
try { require('dotenv').config(); } catch (e) {}
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DRY = process.argv.includes('--dry');

(async () => {
  const { data: products } = await sb.from('products').select('id, name, images');
  const candidatos = products.filter((p) => (p.images || []).some((u) => u.includes('?v=')));
  console.log(`Candidatos (imágenes del mejorador): ${candidatos.length}`);

  // 1) HEAD de todas las imágenes
  const meta = new Map(); // url -> { ct, len }
  for (const p of candidatos) {
    for (const u of p.images) {
      const clean = u.split('?')[0];
      if (meta.has(clean)) continue;
      const r = await fetch(clean, { method: 'HEAD' }).catch(() => null);
      meta.set(clean, {
        ct: r ? (r.headers.get('content-type') || '') : '',
        len: r ? Number(r.headers.get('content-length') || 0) : 0,
      });
    }
  }

  // 2) tamaños repetidos en 4+ productos distintos = banner
  const productosPorLen = new Map();
  for (const p of candidatos) {
    const vistos = new Set();
    for (const u of p.images) {
      const { len } = meta.get(u.split('?')[0]) || {};
      if (!len || vistos.has(len)) continue;
      vistos.add(len);
      productosPorLen.set(len, (productosPorLen.get(len) || 0) + 1);
    }
  }
  const lenBanner = new Set([...productosPorLen].filter(([, n]) => n >= 4).map(([l]) => l));
  console.log(`Tamaños identificados como banner: ${lenBanner.size}`);

  // 3) limpiar
  let limpiados = 0, vacios = 0;
  for (const p of candidatos) {
    const buenas = p.images.filter((u) => {
      const { ct, len } = meta.get(u.split('?')[0]) || {};
      if (/svg/.test(ct)) return false;
      if (len && lenBanner.has(len)) return false;
      return true;
    });
    if (buenas.length === p.images.length) continue;
    if (!buenas.length) {
      vacios++;
      console.log(`  ⚠ ${p.name.slice(0, 55)} quedaría SIN imágenes — no se toca (revisar a mano)`);
      continue;
    }
    limpiados++;
    console.log(`  ${DRY ? '[DRY] ' : '✔ '}${p.name.slice(0, 55)}: ${p.images.length} → ${buenas.length}`);
    if (!DRY) await sb.from('products').update({ images: buenas }).eq('id', p.id);
  }
  console.log(`\nLimpiados: ${limpiados} | Sin solución automática: ${vacios}`);
})();
