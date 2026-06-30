create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists password_resets_user_id_idx on password_resets(user_id);

alter table password_resets enable row level security;
-- Sin políticas públicas: solo la service role (usada por la Edge Function) puede leer/escribir.
