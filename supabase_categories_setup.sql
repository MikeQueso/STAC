-- ════════════════════════════════════════════════════════
--  STAC · Tabla de categorías
--  Pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now()
);

alter table categories enable row level security;

create policy "Cualquiera puede ver categorias"
on categories for select
using (true);

create policy "Solo admin modifica categorias"
on categories for all
using (is_admin())
with check (is_admin());

-- Categorías iniciales (las que ya usan tus productos actuales)
insert into categories (name) values
('Procesador'),
('Tarjeta Gráfica'),
('Memoria RAM'),
('Fuente de Poder'),
('Placa Madre'),
('Almacenamiento'),
('Refrigeración'),
('Gabinete')
on conflict (name) do nothing;

-- ════════════════════════════════════════════════════════
-- LISTO. Ahora tu papá podrá crear/borrar categorías y
-- productos directamente desde el Panel Admin del sitio.
-- ════════════════════════════════════════════════════════
