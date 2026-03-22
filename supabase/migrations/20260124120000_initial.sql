-- Rotifer Cloud Binding — Initial Schema
-- Supabase (PostgreSQL) implementation

-- Profiles: linked to Supabase Auth users
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar_url text,
  github_id bigint unique,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_profiles_username on profiles(username);

-- Genes: published gene metadata
create table genes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  domain text not null,
  version text not null,
  fidelity text not null default 'Wrapped',
  description text,
  phenotype jsonb not null,
  wasm_path text,
  wasm_size bigint default 0,
  downloads bigint default 0,
  published boolean default true,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(owner_id, name, version)
);

create index idx_genes_domain on genes(domain);
create index idx_genes_owner on genes(owner_id);
create index idx_genes_name on genes(name);
create index idx_genes_published on genes(published) where published = true;

-- Full-text search index
alter table genes add column fts tsvector
  generated always as (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(domain, ''))
  ) stored;

create index idx_genes_fts on genes using gin(fts);

-- Arena entries: cloud Arena rankings
create table arena_entries (
  id uuid primary key default gen_random_uuid(),
  gene_id uuid unique not null references genes(id) on delete cascade,
  domain text not null,
  fitness_value double precision not null default 0,
  safety_score double precision not null default 0,
  success_rate double precision not null default 0,
  latency_score double precision not null default 0,
  resource_efficiency double precision not null default 0,
  total_calls bigint default 0,
  last_evaluated timestamptz default now() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_arena_domain on arena_entries(domain);
create index idx_arena_fitness on arena_entries(domain, fitness_value desc);

-- Download log: track gene downloads
create table downloads (
  id uuid primary key default gen_random_uuid(),
  gene_id uuid not null references genes(id) on delete cascade,
  user_id uuid references profiles(id),
  ip_hash text,
  created_at timestamptz default now() not null
);

create index idx_downloads_gene on downloads(gene_id);

-- Auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at before update on profiles
  for each row execute function update_updated_at();

create trigger genes_updated_at before update on genes
  for each row execute function update_updated_at();

create trigger arena_updated_at before update on arena_entries
  for each row execute function update_updated_at();

-- RLS policies

alter table profiles enable row level security;
alter table genes enable row level security;
alter table arena_entries enable row level security;
alter table downloads enable row level security;

-- Profiles: public read, owner write
create policy "Profiles are publicly readable"
  on profiles for select using (true);

create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

-- Genes: public read for published, owner write
create policy "Published genes are publicly readable"
  on genes for select using (published = true);

create policy "Owners can read own unpublished genes"
  on genes for select using (auth.uid() = owner_id);

create policy "Authenticated users can publish genes"
  on genes for insert with check (auth.uid() = owner_id);

create policy "Owners can update own genes"
  on genes for update using (auth.uid() = owner_id);

create policy "Owners can delete own genes"
  on genes for delete using (auth.uid() = owner_id);

-- Arena: public read, gene owner can submit
create policy "Arena rankings are publicly readable"
  on arena_entries for select using (true);

create policy "Gene owners can submit to arena"
  on arena_entries for insert with check (
    exists (select 1 from genes where genes.id = gene_id and genes.owner_id = auth.uid())
  );

create policy "Gene owners can update arena entry"
  on arena_entries for update using (
    exists (select 1 from genes where genes.id = gene_id and genes.owner_id = auth.uid())
  );

-- Downloads: public insert (anonymous downloads allowed), read by gene owner
create policy "Anyone can log downloads"
  on downloads for insert with check (true);

create policy "Gene owners can view download stats"
  on downloads for select using (
    exists (select 1 from genes where genes.id = gene_id and genes.owner_id = auth.uid())
  );

-- Function: get rankings with computed rank
create or replace function get_arena_rankings(
  p_domain text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  rank bigint,
  gene_id uuid,
  gene_name text,
  owner_username text,
  domain text,
  fidelity text,
  fitness_value double precision,
  safety_score double precision,
  total_calls bigint,
  last_evaluated timestamptz
) as $$
begin
  return query
    select
      row_number() over (
        partition by ae.domain order by ae.fitness_value desc
      ) as rank,
      g.id as gene_id,
      g.name as gene_name,
      p.username as owner_username,
      ae.domain,
      g.fidelity,
      ae.fitness_value,
      ae.safety_score,
      ae.total_calls,
      ae.last_evaluated
    from arena_entries ae
    join genes g on g.id = ae.gene_id
    join profiles p on p.id = g.owner_id
    where g.published = true
      and (p_domain is null or ae.domain = p_domain)
    order by ae.domain, ae.fitness_value desc
    limit p_limit
    offset p_offset;
end;
$$ language plpgsql security definer;
