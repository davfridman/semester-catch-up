# The shared contract

Three programs read and write the same Supabase table, `docs` (`user_id`, `col`, `id`, `data`, `updated_at`):

- the iPhone app (`semester-ios`);
- the web app (`index.html` and its scripts; see `ARCHITECTURE.md`);
- the Python tools in `tools/`, run by the hourly GitHub Action, the nightly Claude routine and on the Mac.

This folder holds what they agree on, so the rules and the data stop drifting apart.

| File | What it is | Who reads it |
| --- | --- | --- |
| `check_sync.mjs` | Merge-on-save (`sync.js`): the iPhone app's `FieldPatchTests` and `SyncEngineTests` cases against an in-memory store, and the web app's data layer on top. `live_sync_check.mjs` runs the store against the real table, on `note/sync-check` only. | `run_checks.sh`; the live check by hand with `SC_LIVE=1` |
| `fixtures/rules.json` | Rule cases at a fixed `now` (noon, 2 Nov 2026): task status and its text, importance, priority, course ranking, catch-up, semester weeks, date styles, and reading the plan (`prefs.plan` and `prefs.planSlots`, current and first-version formats). | `check_web.mjs`, `tools/contract_rules.py`, and the iPhone app's `RulesTests` (it uses the same keys) |
| `schema/<collection>.json` | One JSON Schema (draft 2020-12) per collection: `course`, `item`, `settings`, `question`, `update`, `insight`, `note`. Field types, which fields are required, and `x-writers` on each field. | `tools/contract_check.py` |
| `fixtures/docs.json`, `fixtures/docs-bad.json` | Synthetic documents: one set that must pass the schemas, one that must fail in the listed places. | `contract_check.py --self-test` |

The iPhone app is the reference for the rules: it's the one used every day. When another writer disagrees with a case, fix that writer, not the case.

## The data rules

- Unknown fields stay allowed (`additionalProperties: true`). Every writer keeps fields it doesn't know.
- `x-writers` says who may change a field:
  - `app`: the iPhone app;
  - `web`: the web app;
  - `sync`: `moodle_sync.py` and `shnaton.py`;
  - `claude`: `claude_edit.py` and `questions.py`;
  - `user-only` (on its own): only the user, by hand, in either app or with a tool run by hand. No sync and no Claude run writes it.

  `x-note` gives the conditions where there are some. A field inside an object has its parent's writers unless it names its own. An empty list means nothing changes it any more: it was set when the item was imported.
- Items: every field named in an item's `locked` list is the user's. The syncs and Claude keep the user's version. The apps add a field to `locked` when the user edits it, and `note` on every edit.
- Settings documents pick their schema by row id (`x-documents` in `settings.json`), because `data.id` is sometimes missing. Notes pick theirs by `kind`.
- `settings/moodle` and `settings/github` hold tokens. Tools must never print or copy them. The checker never prints a value.

## Adding a field

1. Add it to `schema/<collection>.json`, under `properties`: its type, a `description` if the name isn't obvious, and `x-writers`. Use `$defs/day` (`"2026-11-02"` or `""`), `$defs/time` (`"23:59"` or `""`) and `$defs/stamp` (ISO date and time) for dates.
2. Add it to `fixtures/docs.json` if it has a new shape, and a broken case to `fixtures/docs-bad.json` with its expected problem.
3. Run the checks, including `contract_check.py --live` once the field is in use.
4. Tell the other writers: the iPhone app's record type in `Core/Domain/`, and the web app or the tools if they read the field.

A new rule case goes in `fixtures/rules.json`. Run it against all three: `node contract/check_web.mjs` here, `RulesTests` in Xcode, and `tools/contract_rules.py` when Python implements that rule.

## Running the checks

```sh
sh contract/run_checks.sh                           # everything that needs no data or credentials (CI-ready)
node contract/check_web.mjs                         # rule cases against rules.js, and through the page's bindings (models.js)
node contract/check_sync.mjs                        # merge-on-save against an in-memory store
SC_LIVE=1 node contract/live_sync_check.mjs         # merge-on-save against the live table, on note/sync-check only (service key)
python3 tools/contract_rules.py                     # rule cases the Python tools implement (plan reading, lectures behind)
python3 tools/contract_check.py --self-test         # the schemas and the synthetic fixtures
python3 tools/contract_check.py BACKUP/docs.json    # a dump: the backup's docs.json, or backup_dump.py's output
python3 tools/contract_check.py --live              # the live table, read-only (credentials as in supabase_load.py)
```

Each check exits non-zero when something fails. They need only Node and Python's standard library: no installs, no build step.
