// sync.js's SupabaseStore and SyncEngine against the real docs table, on one throwaway row only: note/sync-check,
// which the apps and tools ignore (the iPhone app's SupabaseStoreLiveTests uses the same row).
//   SC_LIVE=1 node contract/live_sync_check.mjs
// Not part of run_checks.sh: it needs the service key, from the environment (SUPABASE_URL, SUPABASE_SERVICE_KEY,
// SUPABASE_EMAIL or SUPABASE_USER_ID) or ~/.config/semester-catchup/supabase.local.json, as in tools/supabase_load.py.
// It prints results and counts only, never a key or any data. Every read and write goes through a guard that
// refuses any row except note/sync-check (the one exception is a read-only count of all rows).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.SC_LIVE) { console.log('live sync check skipped (set SC_LIVE=1 to run it against the real table)'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8'), ctx, { filename: 'sync.js' });
const Sync = vm.runInContext('Sync', ctx);
// The vendored supabase-js is a browser bundle: it wants `self`, and a script location for its (unused) chunk path.
Object.assign(globalThis, { self: globalThis, importScripts: () => {}, location: 'http://localhost/' });
const { createClient } = createRequire(import.meta.url)(path.join(ROOT, 'vendor/supabase.js'));
delete globalThis.importScripts; delete globalThis.location;

function config() {
  if (process.env.SUPABASE_SERVICE_KEY) return { url: process.env.SUPABASE_URL, service_key: process.env.SUPABASE_SERVICE_KEY, email: process.env.SUPABASE_EMAIL, user_id: process.env.SUPABASE_USER_ID };
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/semester-catchup/supabase.local.json'), 'utf8'));
}
const cfg = config();
async function userId() {
  if (cfg.user_id) return cfg.user_id;
  const r = await fetch(`${cfg.url}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: cfg.service_key, Authorization: `Bearer ${cfg.service_key}` } });
  if (!r.ok) throw new Error(`account list: HTTP ${r.status}`);
  const j = await r.json(), users = Array.isArray(j) ? j : j.users || [];
  const u = users.find(x => (x.email || '').toLowerCase() === (cfg.email || '').toLowerCase());
  if (!u) throw new Error('no account for the configured email');
  return u.id;
}

const K = Sync.key('note', 'sync-check');
const client = createClient(cfg.url, cfg.service_key, { auth: { persistSession: false, autoRefreshToken: false } });
const real = new Sync.SupabaseStore(client, await userId());
const only = keys => { for (const k of keys) if (k !== K) throw new Error('refused: the live check only touches note/sync-check'); };
// The guard: this row only. `between` runs once after the next read, like MemoryStore.onLoad.
const store = {
  between: null,
  async loadAll() { return (await real.loadAll()).filter(d => d.key === K); },
  async load(keys) { only(keys); const out = await real.load(keys); const h = this.between; this.between = null; if (h) await h(); return out; },
  async write(k, data, stamp) { only([k]); return real.write(k, data, stamp); },
  async overwrite() { throw new Error('refused: no whole-document writes in the live check'); },
};

const fails = []; let count = 0;
const ok = (name, cond) => { count++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails.push(name); };
const doc = { kind: 'sync-check' };

let before = (await store.load([K])).get(K);
if (!before) {
  const r = await store.write(K, { ...doc, n: 0 }, null);
  ok('the throwaway row didn’t exist, so it was created', !!r.ok);
  before = (await store.load([K])).get(K);
}
ok('the stamp is kept in UTC as …Z', Sync.isUTC(before.stamp));

// The right stamp writes and returns a new stamp.
const n = (typeof before.data.n === 'number' ? before.data.n : 0) + 1;
const w = await store.write(K, { ...doc, n }, before.stamp);
ok('a write with the current stamp is accepted', !!w.ok);
ok('and gives the row a new stamp', !!w.ok && w.stamp !== before.stamp && Sync.isUTC(w.stamp));
// The old stamp is now stale: refused.
ok('a write with a stale stamp is refused', !!(await store.write(K, { ...doc, n: -1 }, before.stamp)).conflict);
// Creating a document that already exists: refused, not overwritten.
ok('an insert of an existing row is refused (23505)', !!(await store.write(K, { ...doc, n: -2 }, null)).conflict);
ok('and neither refused write changed the row', (await store.load([K])).get(K)?.data.n === n);

// The engine on top: another writer changes the row right after the engine reads it, so the first write is
// refused, the engine reads again and merges, and both changes stay.
const engine = new Sync.SyncEngine(store);
engine.adopt(await engine.fetchAll());
store.between = async () => { const cur = (await real.load([K])).get(K); await real.write(K, { ...cur.data, other: 'theirs' }, cur.stamp); };
const adjusted = await engine.push(new Map([[K, { ...doc, n, checked: true }]]));
const saved = (await store.load([K])).get(K)?.data || {};
ok('a save after someone else wrote in between keeps both changes', saved.checked === true && saved.other === 'theirs' && saved.n === n);
ok('and the engine reports the merged version to show', adjusted.has(K) && adjusted.get(K).other === 'theirs');
// Leave the row as the iPhone app's check expects it.
const last = (await store.load([K])).get(K);
ok('the row is put back to its usual shape', !!(await store.write(K, { ...doc, n }, last.stamp)).ok);

const all = await real.loadAll();   // read-only
ok(`a full download reads every row (${all.length})`, all.length > 300);

console.log(`live sync check: ${count - fails.length}/${count} pass`);
process.exit(fails.length ? 1 : 0);
