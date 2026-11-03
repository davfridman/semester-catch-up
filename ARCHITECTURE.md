# Web app structure

The web app follows the iPhone app's layout (`semester-ios`, restructure steps 3–4), as plain scripts with no build step. `index.html` loads them in this order; they share one global scope, and only `router.js` starts anything.

| File | What it holds |
| --- | --- |
| `config.js`, `vendor/supabase.js` | The public Supabase settings, and supabase-js. |
| `rules.js` | The pure rules: status, importance, ranking, catch-up, weeks, date styles, the plan's format. Checked against `contract/fixtures/rules.json`. |
| `sync.js` | Merge-on-save: `fieldPatch`, `applyPatch`, `SyncEngine`, `MemoryStore` (tests) and `SupabaseStore`. Pure; no page, no state. |
| `data.js` | The data layer, the only file that touches storage: the state `S`, loading (Supabase or the demo file), saving through `sync.js`, signing in and out. Screens hear about changes through `dataEvents`. |
| `models.js` | The shared models: the rules bound to `S` (courses, items, the plan as read, the feed cards, your notes). They decide; they never change data or draw. |
| `ui.js` | Shared rendering: formats, icons, rings, the task card, the feed card, segmented controls, the theme, toasts. |
| `features/*.js` | One file per feature: `overview`, `plan`, `courses`, `schedule`, `item`, `feed`, `chat`, `questions`, `notes`, `settings`, `account`. Each has a model part (its actions, which change data through `data.js`) and a views part (its screens and sheets, which return HTML). |
| `router.js` | Which screen and sheet show, every tap and field sent to its feature, the 2-minute reload, and the start. Loaded last. |

The rules between them:

- Features don't call each other. They draw `data-*` attributes; the router sends each tap to the feature it belongs to. What several features read lives in `models.js` (the plan as read, the feed cards) or `ui.js` (the card).
- Views render; models decide. Rules stay pure in `rules.js`. Only `data.js` touches storage.

Adding a file: add its `<script>` to `index.html` (before `router.js`), add it to `sw.js`'s `SHELL`, and bump the cache version.

## How saving works

The same as the iPhone app (`semester-ios` DESIGN.md, "Restructure step 3"; ticket davfridman/semester-project#11):

1. A feature changes the app's copy of a document through `optimistic` (redraw now) or `patch` (redraw after the save). Saving is scheduled 250 ms later, so a burst of changes goes out together. Leaving the page saves right away.
2. The engine keeps a **base**: the last copy of each document known to be on the server. A document that differs from its base counts as changed. An empty prefs document never counts, so a fresh device can't blank the settings.
3. For each changed document it computes the **field patch** from the base to the app's copy. Objects are compared key by key; arrays and plain values count as one field; removed fields count too.
4. It reads the server's current copy and its `updated_at`, applies the patch on top, and writes only if `updated_at` is unchanged: `update … where user_id, col, id and updated_at = <stamp>`, returning the row. No row back means someone wrote in between: it reads again and retries, up to 4 times. A new document is inserted, and a duplicate key (23505) counts as the same kind of conflict.
5. When the saved version differs from the app's (another writer's change was kept), the app shows the saved version, with any edit you made during the save put back on top.
6. **A download never moves the base while edits are pending.** Loading saves pending edits first, then downloads, and adopts the download (it becomes the app's copy and the base) only when nothing changed in the meantime.

Details:

- **Stamps.** Supabase returns `…+00:00`; a `+` in a query string reads as a space, so stamps are kept as `…Z`. A stamp that isn't UTC is written without the check.
- **The sync switch.** `prefs.syncMode == "whole"` (set with `tools/sync_mode.py whole`) saves whole documents the old way, last writer wins.
- **Change history and undo.** Every change keeps the version before it in `docs_history` (`supabase/migrations/004_history.sql`), with who made it: the iPhone app, the web app, or a job (the Python tools send `X-Writer: tool:<name>`). `tools/history.py` lists changes, `show HID` shows one field by field, and `undo HID` puts back only the fields that change touched, on the same stamp check the apps use; it refuses when a later change touched those fields (`--force` overrides).
- **Never delete rows.** The apps hide items instead, and nobody has delete rights. Nothing in `sync.js` deletes.
- **Demo mode** (`?demo=file.json` on localhost) has no engine, so it never writes.
- **Another account** signing in starts from empty data, so nothing of the previous account can be saved into it.

## Checks

- `sh contract/run_checks.sh` runs `node --check` on every script and `contract/check_sync.mjs`: the iPhone app's `FieldPatchTests` and `SyncEngineTests` against an in-memory store, then the app's own data layer (load, edit, save) with the page's scripts loaded in order.
- `SC_LIVE=1 node contract/live_sync_check.mjs` checks `SupabaseStore` against the real table, on the throwaway row `note/sync-check` only: a write with the right stamp works, a stale stamp and an insert of an existing row are refused, and a save merges with a change made in between. It needs the service key (as in `tools/supabase_load.py`), prints no data, and isn't part of `run_checks.sh`.
