-- ════════════════════════════════════════════════════════
--  STAC · Imágenes de garantía + reseñas con estrellas
--  Pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

-- 1) Fotos de garantía/certificaciones (separadas de la galería principal)
alter table products add column if not exists badge_images text[] default '{}';

-- 2) Tabla de reseñas (calificación + comentario)
create table reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now(),
  unique(product_id, user_id)
);

alter table reviews enable row level security;

create policy "Cualquiera puede ver reseñas"
on reviews for select
using (true);

create policy "Usuario crea su propia reseña"
on reviews for insert
with check (auth.uid() = user_id);

create policy "Usuario edita su propia reseña"
on reviews for update
using (auth.uid() = user_id);

create policy "Usuario borra su propia reseña"
on reviews for delete
using (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════
-- NOTA: como el sitio todavía no tiene un sistema de compras
-- real (el carrito es solo visual), cualquier usuario
-- registrado puede calificar — no solo "quien compró".
-- Si más adelante agregamos pedidos reales, podemos
-- restringir esto a compradores verificados.
-- ════════════════════════════════════════════════════════
