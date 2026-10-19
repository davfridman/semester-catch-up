-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- One table holds everything as small JSON documents: courses, items (lectures, tasks) and settings.
create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  col        text        not null check (col in ('course', 'item', 'settings', 'question', 'update', 'note', 'insight')),
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);

-- Only the signed-in owner can see or change their rows.
alter table public.docs enable row level security;
drop policy if exists "docs: owner reads"   on public.docs;
drop policy if exists "docs: owner inserts" on public.docs;
drop policy if exists "docs: owner updates" on public.docs;
drop policy if exists "docs: owner deletes" on public.docs;
create policy "docs: owner reads"   on public.docs for select using (auth.uid() = user_id);
create policy "docs: owner inserts" on public.docs for insert with check (auth.uid() = user_id);
create policy "docs: owner updates" on public.docs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "docs: owner deletes" on public.docs for delete using (auth.uid() = user_id);

-- Live updates between your iPhone and Mac.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
