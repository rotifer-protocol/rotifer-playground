-- Auto-create profile when a new auth user is created
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, avatar_url, github_id)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'user_name',
      new.raw_user_meta_data->>'preferred_username',
      'user_' || substr(new.id::text, 1, 8)
    ),
    new.raw_user_meta_data->>'avatar_url',
    (new.raw_user_meta_data->>'provider_id')::bigint
  )
  on conflict (id) do update set
    username = excluded.username,
    avatar_url = excluded.avatar_url,
    github_id = excluded.github_id,
    updated_at = now();
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill: create profiles for any existing auth users
insert into public.profiles (id, username, avatar_url, github_id)
select
  u.id,
  coalesce(
    u.raw_user_meta_data->>'user_name',
    u.raw_user_meta_data->>'preferred_username',
    'user_' || substr(u.id::text, 1, 8)
  ),
  u.raw_user_meta_data->>'avatar_url',
  (u.raw_user_meta_data->>'provider_id')::bigint
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
