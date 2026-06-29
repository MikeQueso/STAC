-- ════════════════════════════════════════════════════════
--  STAC · Pedidos y pagos (Stripe)
--  Pega esto en: Supabase → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  stripe_session_id text unique,
  status text not null default 'pending',   -- pending | paid | failed | canceled
  total numeric not null,
  currency text not null default 'mxn',
  created_at timestamptz default now(),
  paid_at timestamptz
);

create table order_items (
  id bigserial primary key,
  order_id uuid references orders(id) on delete cascade not null,
  product_id uuid references products(id) on delete set null,
  name text not null,        -- copia del nombre al momento de comprar (por si el producto cambia después)
  price numeric not null,    -- copia del precio al momento de comprar
  quantity int not null
);

create index idx_orders_user on orders(user_id);
create index idx_order_items_order on order_items(order_id);

alter table orders enable row level security;
alter table order_items enable row level security;

-- Cada usuario ve solo sus propios pedidos.
create policy "El usuario ve sus propios pedidos"
on orders for select
using (auth.uid() = user_id);

create policy "El usuario ve los items de sus propios pedidos"
on order_items for select
using (exists (select 1 from orders where orders.id = order_items.order_id and orders.user_id = auth.uid()));

-- ════════════════════════════════════════════════════════
-- Nota: las funciones de pago (create-checkout-session y
-- stripe-webhook) corren con la SERVICE ROLE KEY, así que
-- ignoran RLS para crear/actualizar pedidos sin necesitar
-- políticas de insert/update aquí.
-- ════════════════════════════════════════════════════════
