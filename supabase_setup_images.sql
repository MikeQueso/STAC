-- ════════════════════════════════════════════════════════
--  STAC · Agregar soporte de fotos de producto (varias por producto)
--  Pega esto en: SQL Editor → New query → Run
--  (Esto se agrega a lo que ya corriste antes, no lo reemplaza)
-- ════════════════════════════════════════════════════════

-- 1) Bucket de almacenamiento para las fotos (público para que se vean)
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- 2) Tabla para guardar varias fotos por producto
create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  url text not null,
  path text not null,
  sort_order int default 0,
  created_at timestamptz default now()
);

alter table product_images enable row level security;

create policy "Cualquiera puede ver imagenes de producto"
on product_images for select
using (true);

create policy "Solo admin modifica imagenes de producto"
on product_images for all
using (is_admin())
with check (is_admin());

-- 3) Políticas de almacenamiento: quién puede subir / ver / borrar archivos
create policy "Cualquiera puede ver archivos del bucket"
on storage.objects for select
using (bucket_id = 'product-images');

create policy "Admin puede subir archivos"
on storage.objects for insert
with check (bucket_id = 'product-images' and is_admin());

create policy "Admin puede borrar archivos"
on storage.objects for delete
using (bucket_id = 'product-images' and is_admin());

-- ════════════════════════════════════════════════════════
-- LISTO. Ya puedes subir fotos desde el panel de edición del sitio.
-- ════════════════════════════════════════════════════════
