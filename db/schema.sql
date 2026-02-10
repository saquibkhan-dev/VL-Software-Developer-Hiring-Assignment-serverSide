-- Enable UUIDs
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Profiles table
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz default now()
);

-- Queries table
create table if not exists queries (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  query_text text not null,
  created_at timestamptz default now()
);

-- Resources table
create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  type text not null check (type in ('ppt', 'video')),
  storage_path text not null,
  created_at timestamptz default now()
);

create index if not exists resources_title_trgm_idx on resources using gin (title gin_trgm_ops);
create index if not exists resources_description_trgm_idx on resources using gin (description gin_trgm_ops);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Storage bucket
insert into storage.buckets (id, name, public)
values ('learning-resources', 'learning-resources', true)
on conflict (id) do nothing;

-- Sample resource entries
insert into resources (title, description, type, storage_path)
values
  ('RAG 101 Deck', 'Introductory slides covering retrieval augmented generation.', 'ppt', 'rag-101.pptx'),
  ('RAG Walkthrough Video', 'Short recorded session on RAG concepts.', 'video', 'rag-walkthrough.mp4');

-- RLS
alter table profiles enable row level security;
alter table queries enable row level security;
alter table resources enable row level security;

-- Policies
create policy "Profiles are viewable by owner" on profiles
  for select using (auth.uid() = id);

create policy "Profiles are insertable by owner" on profiles
  for insert with check (auth.uid() = id);

create policy "Queries are insertable by owner" on queries
  for insert with check (auth.uid() = profile_id);

create policy "Queries are viewable by owner" on queries
  for select using (auth.uid() = profile_id);

create policy "Resources are viewable by authenticated users" on resources
  for select using (auth.role() = 'authenticated');

-- Storage policy: authenticated users can read
create policy "Authenticated can read learning resources" on storage.objects
  for select using (
    bucket_id = 'learning-resources'
    and auth.role() = 'authenticated'
  );
