alter table profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Avatar lectura publica" on storage.objects;
create policy "Avatar lectura publica"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "Avatar subida propia" on storage.objects;
create policy "Avatar subida propia"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Avatar actualizacion propia" on storage.objects;
create policy "Avatar actualizacion propia"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Avatar borrado propio" on storage.objects;
create policy "Avatar borrado propio"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
