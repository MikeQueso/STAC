-- ════════════════════════════════════════════════════════
--  STAC · Campos para fabricante y descripción rica
--  Pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

alter table products add column if not exists brand_description text;
alter table products add column if not exists brand_logo text;
alter table products add column if not exists specs_rich text;

-- specs_rich guarda las especificaciones con sus categorías
-- en formato: "Categoría|||Etiqueta: Valor\nCategoría|||Etiqueta2: Valor2"
-- Esto permite renderizar la tabla agrupada que se ve en la referencia.
