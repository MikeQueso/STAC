-- ════════════════════════════════════════════════════════
--  STAC · Soporte de fotos para productos
--  IMPORTANTE: primero crea el bucket "product-images" en
--  Storage → New bucket → marca "Public bucket" → Create.
--  Luego pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

-- 1) Nueva columna para guardar las URLs de las fotos (varias por producto)
alter table products add column if not exists images text[] default '{}';

-- 2) Reglas de acceso al bucket de imágenes
create policy "Lectura publica de imagenes de productos"
on storage.objects for select
using (bucket_id = 'product-images');

create policy "Solo admin sube imagenes"
on storage.objects for insert
with check (bucket_id = 'product-images' and is_admin());

create policy "Solo admin borra imagenes"
on storage.objects for delete
using (bucket_id = 'product-images' and is_admin());

create policy "Solo admin actualiza imagenes"
on storage.objects for update
using (bucket_id = 'product-images' and is_admin());
