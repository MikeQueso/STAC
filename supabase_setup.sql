-- ════════════════════════════════════════════════════════
--  STAC · Setup de base de datos en Supabase
--  Pega esto completo en: Proyecto → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

-- 1) TABLA DE PERFILES (usuarios registrados)
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique not null,
  email text not null,
  role text not null default 'user',   -- 'user' o 'admin'
  created_at timestamptz default now()
);

-- 2) TABLA DE PRODUCTOS
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  price numeric not null,
  old_price numeric,
  ref text,
  emoji text,
  badge text,                          -- 'HOT' | 'NUEVO' | 'EN STOCK' | '-15%' etc.
  created_at timestamptz default now()
);

-- 3) TABLA DE VISTAS DE PRODUCTO (para el panel admin)
create table product_views (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  viewed_at timestamptz default now()
);

-- 4) FUNCIÓN AUXILIAR: ¿el usuario actual es admin?
--    (security definer evita problemas de recursión en las políticas RLS)
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

-- 5) FUNCIÓN: buscar el correo asociado a un nombre de usuario
--    (permite que el login se haga con "usuario" en vez de correo)
create or replace function get_email_by_username(uname text)
returns text
language sql
security definer
set search_path = public
as $$
  select email from profiles where username = uname limit 1;
$$;

grant execute on function get_email_by_username(text) to anon, authenticated;

-- 6) ROW LEVEL SECURITY — profiles
alter table profiles enable row level security;

create policy "Usuario ve su propio perfil"
on profiles for select
using (auth.uid() = id);

create policy "Admin ve todos los perfiles"
on profiles for select
using (is_admin());

create policy "Usuario crea su propio perfil"
on profiles for insert
with check (auth.uid() = id);

create policy "Usuario actualiza su propio perfil"
on profiles for update
using (auth.uid() = id);

-- 7) ROW LEVEL SECURITY — products
alter table products enable row level security;

create policy "Cualquiera puede ver productos"
on products for select
using (true);

create policy "Solo admin modifica productos"
on products for all
using (is_admin())
with check (is_admin());

-- 8) ROW LEVEL SECURITY — product_views
alter table product_views enable row level security;

create policy "Usuario inserta sus propias vistas"
on product_views for insert
with check (auth.uid() = user_id);

create policy "Usuario ve sus propias vistas"
on product_views for select
using (auth.uid() = user_id);

create policy "Admin ve todas las vistas"
on product_views for select
using (is_admin());

-- 9) PRODUCTOS INICIALES (tu catálogo actual)
insert into products (name, category, price, old_price, ref, emoji, badge) values
('Intel Core i9-14900K',          'Procesador',       11450, null, 'BX8071514900K',       '🔲', 'HOT'),
('NVIDIA RTX 4070 Ti Super',      'Tarjeta Gráfica',  15200, null, 'RTX4070TIS-16G',      '🎮', 'NUEVO'),
('Corsair Vengeance 32GB DDR5',   'Memoria RAM',       2650, null, 'CMK32GX5M2B6000Z30',  '💾', 'EN STOCK'),
('Corsair RM850x 850W 80+ Gold',  'Fuente de Poder',   2890, 3400, 'CP-9020200-NA',       '🔋', '-15%'),
('ASUS ROG Strix B650-A',        'Placa Madre',        5490, null, 'ROG-STRIX-B650-A',    '🧩', 'NUEVO'),
('Samsung 990 Pro 2TB NVMe',     'Almacenamiento',     3150, null, 'MZ-V9P2T0BW',         '💿', 'HOT'),
('Cooler Master Hyper 212',      'Refrigeración',       680, null, 'RR-212S-20PK-R2',     '❄️', 'EN STOCK'),
('NZXT H510 Flow',               'Gabinete',           1890, 2100, 'CC-H51FB-01',         '🗄️', '-10%');

-- ════════════════════════════════════════════════════════
-- LISTO. Ahora ve al paso 3 en el chat para crear al usuario
-- admin "fernando" desde Authentication → Users.
-- ════════════════════════════════════════════════════════
