-- Run once in the Supabase SQL editor.
-- The apps never delete rows (they hide items instead), so nobody needs delete rights.
-- This stops any device, including an old copy of the app still open somewhere, from deleting your data.
drop policy if exists "docs: owner deletes" on public.docs;
