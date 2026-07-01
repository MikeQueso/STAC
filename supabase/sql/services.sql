-- Tabla para el contenido editable de las 3 tarjetas de servicio
CREATE TABLE IF NOT EXISTS services (
  id          integer PRIMARY KEY,          -- 1, 2 ó 3 (posición fija)
  icon        text    NOT NULL DEFAULT '🛠️',
  title       text    NOT NULL DEFAULT 'Próximamente',
  description text    NOT NULL DEFAULT 'Estamos preparando la información de este servicio.',
  sections    jsonb   NOT NULL DEFAULT '[]', -- [{type,content/items/url/caption...}]
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lectura publica" ON services FOR SELECT USING (true);
CREATE POLICY "solo admin escribe" ON services FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Datos iniciales
INSERT INTO services (id, icon, title, description, sections) VALUES
(1, '🛠️', 'Próximamente', 'Estamos preparando la información de este servicio.', '[]'),
(2, '🌐', 'Creación de sitios publicitarios en un entorno web',
   'Diseñamos y desarrollamos páginas web a la medida para promocionar tu negocio.',
   '[{"type":"text","content":"Diseñamos y desarrollamos páginas web a la medida para promocionar tu negocio o tus productos, con un diseño profesional, rápido y adaptado a cualquier dispositivo.\n\nNos encargamos de todo el proceso: desde la planeación y el diseño visual, hasta la programación, la integración de catálogos, formularios de contacto y todo lo necesario para que tu presencia en línea sea efectiva."},{"type":"list","style":"bullet","items":["Diseño visual personalizado","Catálogo de productos integrado","Formulario de contacto","Adaptado a móvil y escritorio","Entrega en tiempo acordado"]},{"type":"text","content":"Contáctanos para cotizar tu proyecto."}]'),
(3, '🛠️', 'Próximamente', 'Estamos preparando la información de este servicio.', '[]')
ON CONFLICT (id) DO NOTHING;
