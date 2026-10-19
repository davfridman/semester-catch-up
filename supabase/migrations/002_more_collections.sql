-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- Lets the table also hold Claude's questions, Moodle updates, your notes to Claude, and insights.
alter table public.docs drop constraint if exists docs_col_check;
alter table public.docs add constraint docs_col_check
  check (col in ('course', 'item', 'settings', 'question', 'update', 'note', 'insight'));
