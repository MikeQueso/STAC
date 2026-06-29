// Reemplaza las GPUs por encima de $15,000 por opciones reales bajo ese límite.
try { require('dotenv').config(); } catch (e) {}
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BUCKET = 'productos';

// ref del producto viejo a reemplazar -> datos del nuevo
const REEMPLAZOS = {
  'ROG-STRIX-RTX4090-O24G': {
    name: 'Tarjeta de Video MSI NVIDIA GeForce RTX 5070 INSPIRE 3X OC 12GB GDDR7',
    price: 13999, brand: 'MSI',
    image: 'https://ddtech.mx/assets/uploads/72f7f585fce3443cfcb793b034510e03.png',
    url: 'https://ddtech.mx/producto/tarjeta-de-video-msi-nvidia-geforce-rtx-5070-inspire-3x-oc-12gb-gddr7?id=19143',
    features: [
      { name: 'Modelo', value: 'NVIDIA GeForce RTX 5070' },
      { name: 'Memoria', value: '12GB GDDR7' },
      { name: 'Fabricante', value: 'MSI Inspire 3X OC' },
      { name: 'Interfaz', value: 'PCI Express 4.0' },
    ],
  },
  'GV-N408SAORUS-16GD': {
    name: 'Tarjeta de Video PowerColor Radeon RX 9070 XT REAPER 16GB GDDR6',
    price: 11699, brand: 'PowerColor',
    image: 'https://ddtech.mx/assets/uploads/69f795e0c26ca1a58f205738504bfdd1.png',
    url: 'https://ddtech.mx/producto/tarjeta-de-video-powercolor-radeon-rx-9070-xt-reaper-16gb-gddr6?id=19245',
    features: [
      { name: 'Modelo', value: 'AMD Radeon RX 9070 XT' },
      { name: 'Memoria', value: '16GB GDDR6' },
      { name: 'Fabricante', value: 'PowerColor Reaper' },
      { name: 'Interfaz', value: 'PCI Express 4.0' },
    ],
  },
  'GPU-R001': {
    name: 'Tarjeta de Video Radeon RX 6650 XT 8GB GDDR6 Sapphire Nitro+',
    price: 8599, brand: 'Sapphire',
    image: 'https://ddtech.mx/assets/uploads/19dbe88233020b940c4c2b5d314b0a65.jpg',
    url: 'https://ddtech.mx/producto/tarjeta-de-video-radeon-rx-6650-xt-8gb-gddr6-sapphire-nitro-hdmi-dp-pci-e-4-0-nuevo-chip-rdna-2-11319-01-20g-1-ano-de-garantia-nacional?id=11894',
    features: [
      { name: 'Modelo', value: 'AMD Radeon RX 6650 XT' },
      { name: 'Memoria', value: '8GB GDDR6' },
      { name: 'Fabricante', value: 'Sapphire Nitro+' },
      { name: 'Chip', value: 'RDNA 2' },
      { name: 'Interfaz', value: 'PCI Express 4.0' },
    ],
  },
  'RTX4070TIS-16G': {
    name: 'Tarjeta de Video Gigabyte NVIDIA GeForce RTX 5060 EAGLE MAX OC 8GB',
    price: 7599, brand: 'Gigabyte',
    image: 'https://ddtech.mx/assets/uploads/bf4b4bf0214705ee1c6c7b8b08d891b5.png',
    url: 'https://ddtech.mx/producto/tarjeta-de-video-gigabyte-nvidia-geforce-rtx-5060-eagle-max-oc-8gb-sistemad?id=19223',
    features: [
      { name: 'Modelo', value: 'NVIDIA GeForce RTX 5060' },
      { name: 'Memoria', value: '8GB' },
      { name: 'Fabricante', value: 'Gigabyte Eagle Max OC' },
      { name: 'Interfaz', value: 'PCI Express 4.0' },
    ],
  },
};

function extFromType(ct, url) {
  ct = ct || '';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

(async () => {
  for (const [ref, nuevo] of Object.entries(REEMPLAZOS)) {
    const { data: viejo, error } = await sb.from('products').select('*').eq('ref', ref).single();
    if (error || !viejo) { console.log(`✘ no encontrado ref ${ref}:`, error?.message); continue; }
    console.log(`Reemplazando [${viejo.price}] ${viejo.name} → [${nuevo.price}] ${nuevo.name}`);

    const res = await fetch(nuevo.image, { headers: { 'User-Agent': UA } });
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromType(ct, nuevo.image);
    const path = `${viejo.id}/0.${ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, buf, { contentType: ct || ('image/' + ext), upsert: true });
    if (up.error) { console.log('  ✘ falló subir imagen:', up.error.message); continue; }
    const imgUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

    const specsGroups = [{ name: 'Especificaciones', features: nuevo.features }];
    const specsFlat = nuevo.features.map((f) => `${f.name}: ${f.value}`).join('\n');
    const description_html =
      `<p><strong>${nuevo.name}</strong></p>` +
      `<p>${nuevo.name}. Tarjeta gráfica gamer disponible en STAC. Producto nuevo, original y sellado.</p>`;

    const { error: ue } = await sb.from('products').update({
      name: nuevo.name, price: nuevo.price, images: [imgUrl],
      description: specsFlat, description_html, specs: specsFlat,
      specs_json: JSON.stringify(specsGroups), brand_info: nuevo.brand,
    }).eq('id', viejo.id);
    if (ue) { console.log('  ✘ falló update:', ue.message); continue; }

    await sb.from('precios_abasto').delete().eq('product_id', viejo.id);
    await sb.from('precios_abasto').insert({
      product_id: viejo.id, proveedor: 'DD Tech', precio: nuevo.price,
      url: nuevo.url, encontrado_como: nuevo.name, actualizado_at: new Date().toISOString(),
    });
    console.log('  ✔ listo');
  }
})();
