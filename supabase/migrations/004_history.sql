-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- Keeps the previous version of a document every time it changes, so any single change can be undone
-- and it's clear who made it: the iPhone app, the web app, or the server jobs (sync, Claude, tools).
-- It also stamps every change with a fresh updated_at, which the apps' merge-on-save relies on.
-- davfridman/semester-project#22

create table if not exists public.docs_history (
  hid        bigint generated always as identity primary key,
  user_id    uuid        not null,
  col        text        not null,
  id         text        not null,
  data       jsonb       not null,            -- the version before the change
  op         text        not null,            -- 'update' or 'delete'
  role       text,                            -- 'authenticated' = an app, 'service_role' = a server job
  writer     text,                            -- which client: supabase-swift, supabase-js, or a job's own name
  changed_at timestamptz not null default now()
);
create index if not exists docs_history_doc on public.docs_history (user_id, col, id, changed_at desc);

-- Owners can read their own history; nobody writes to it except the trigger below.
alter table public.docs_history enable row level security;
drop policy if exists "docs_history: owner reads" on public.docs_history;
create policy "docs_history: owner reads" on public.docs_history for select using (auth.uid() = user_id);

create or replace function public.docs_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  headers json := nullif(current_setting('request.headers', true), '')::json;
begin
  if tg_op = 'UPDATE' and old.data is not distinct from new.data then
    return new;  -- nothing changed (e.g. the sync re-saving the same row)
  end if;
  insert into public.docs_history (user_id, col, id, data, op, role, writer)
  values (old.user_id, old.col, old.id, old.data, lower(tg_op),
          nullif(current_setting('request.jwt.claim.role', true), ''),
          coalesce(headers->>'x-writer', headers->>'x-client-info', headers->>'user-agent'));
  return coalesce(new, old);
end $$;

drop trigger if exists docs_keep_history on public.docs;
create trigger docs_keep_history after update or delete on public.docs
  for each row execute function public.docs_keep_history();

-- Every change gets a fresh updated_at, whoever makes it. The apps save only when the row still has the
-- updated_at they last saw (else they re-read and merge), so this stamp is what keeps writers from overwriting each other.
create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.docs_touch();

-- History grows slowly (only real changes are kept). To trim it later, e.g. to the last 180 days:
--   delete from public.docs_history where changed_at < now() - interval '180 days';
