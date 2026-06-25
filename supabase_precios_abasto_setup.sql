-- ════════════════════════════════════════════════════════
--  STAC · Precios de proveedores (Cyberpuerta / Abasteo / DD Tech)
--  Pega esto en: Supabase → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

create table precios_abasto (
  id bigserial primary key,
  product_id uuid references products(id) on delete cascade,
  proveedor text not null,            -- 'Cyberpuerta' | 'Abasteo' | 'DD Tech'
  precio numeric not null,
  url text,
  encontrado_como text,               -- nombre del producto tal cual lo vio en el sitio del proveedor (para que puedas verificar el match)
  actualizado_at timestamptz default now(),
  unique (product_id, proveedor)
);

create index idx_precios_abasto_product on precios_abasto(product_id);

alter table precios_abasto enable row level security;

-- Solo el admin puede ver estos precios (tu papá)
create policy "Solo admin ve precios de proveedores"
on precios_abasto for select
using (is_admin());

-- Solo el admin (o el scraper con la service role key) puede insertar/actualizar
create policy "Solo admin modifica precios de proveedores"
on precios_abasto for all
using (is_admin())
with check (is_admin());

-- ════════════════════════════════════════════════════════
-- Nota: el script de scraping corre con la SERVICE ROLE KEY
-- de Supabase (no la anon key), así que ignora RLS automáticamente
-- y puede escribir aunque no haya un usuario admin autenticado.
-- ════════════════════════════════════════════════════════
