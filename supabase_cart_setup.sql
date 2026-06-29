-- ════════════════════════════════════════════════════════
--  STAC · Carrito de compra
--  Pega esto en: Supabase → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

create table cart_items (
  id bigserial primary key,
  user_id uuid references profiles(id) on delete cascade not null,
  product_id uuid references products(id) on delete cascade not null,
  quantity int not null default 1 check (quantity > 0),
  created_at timestamptz default now(),
  unique (user_id, product_id)
);

create index idx_cart_items_user on cart_items(user_id);

alter table cart_items enable row level security;

-- Cada usuario solo ve y modifica su propio carrito.
create policy "El usuario ve su propio carrito"
on cart_items for select
using (auth.uid() = user_id);

create policy "El usuario agrega a su propio carrito"
on cart_items for insert
with check (auth.uid() = user_id);

create policy "El usuario actualiza su propio carrito"
on cart_items for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "El usuario borra de su propio carrito"
on cart_items for delete
using (auth.uid() = user_id);
