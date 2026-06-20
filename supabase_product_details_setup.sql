-- ════════════════════════════════════════════════════════
--  STAC · Campos para la ficha completa de producto
--  Pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

alter table products add column if not exists brand text;
alter table products add column if not exists description text;
alter table products add column if not exists specs text;
alter table products add column if not exists stock integer not null default 10;

-- ════════════════════════════════════════════════════════
-- LISTO. Ahora los productos pueden tener marca, descripción,
-- especificaciones y cantidad en stock.
-- ════════════════════════════════════════════════════════
