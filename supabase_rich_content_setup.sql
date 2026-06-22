-- ════════════════════════════════════════════════════════
--  STAC · Columnas para descripción enriquecida y specs agrupadas
--  Pega esto en: SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════

-- Descripción en HTML (la de Icecat viene formateada)
alter table products add column if not exists description_html text;

-- Specs agrupadas por categoría en JSON
-- Formato: [{"group":"Procesador","features":[{"name":"Socket","value":"AM4"}]}]
alter table products add column if not exists specs_json text;

-- Texto sobre la marca/fabricante
alter table products add column if not exists brand_info text;
