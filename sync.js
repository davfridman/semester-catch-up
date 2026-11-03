// Merge-on-save: keeps the web app's documents and the server's in step without losing anyone's changes.
// The same rules as the iPhone app (semester-ios Core/Data: FieldPatch, SyncEngine, SupabaseStore), ticket
// davfridman/semester-project#11. Checked by contract/check_sync.mjs against an in-memory store.
//
// The engine remembers the last copy of each document known to be on the server (the base). Saving sends only
// the fields you changed since that base: it reads the server's current copy and its updated_at, puts your
// changes on top, and writes it back only if updated_at is still the same (else it reads again, up to 4 times).
// So a course rule Claude added, or a date the hourly sync moved, stays when you change something else.
// Nothing here deletes a row: the apps hide items instead, and nobody has delete rights.
//
// Loaded as a plain script before data.js; it defines the global `Sync` and touches no page and no state.
'use strict';

const Sync = (() => {
  // ---------- Documents ----------
  /// One document's address in the docs table: "col\0id", the form the iPhone app's cache uses.
  const key = (col, id) => col + '\u0000' + id;
  const split = k => { const i = k.indexOf('\u0000'); return { col: k.slice(0, i), id: k.slice(i + 1) }; };
  const PREFS = key('settings', 'prefs');
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /// JSON semantics: a key whose value is undefined is a missing key.
  const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /// The same JSON value: objects compare key by key (order doesn't matter), arrays element by element.
  function same(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (isObj(a) && isObj(b)) {
      const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
      return ka.length === kb.length && ka.every(k => has(b, k) && same(a[k], b[k]));
    }
    return false;
  }

  // ---------- Field patches ----------
  /// The fields that changed from `base` to `local`, as paths into the JSON: [{ path, value }] or [{ path, remove: true }].
  /// Objects are compared key by key, so two writers changing different fields of the same object both survive.
  /// Arrays and plain values count as one field. Keys are visited in sorted order, like the iPhone app.
  function fieldPatch(base, local, path = []) {
    const out = [], a = isObj(base) ? base : {}, b = isObj(local) ? local : {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const inA = has(a, k), inB = has(b, k), p = [...path, k];
      if (!inA && !inB) continue;
      if (inA && inB && same(a[k], b[k])) continue;
      if (inA && inB && isObj(a[k]) && isObj(b[k])) out.push(...fieldPatch(a[k], b[k], p));
      else out.push(inB ? { path: p, value: clone(b[k]) } : { path: p, remove: true });
    }
    return out;
  }

  /// A copy of `doc` with the changes on top. A change wins over whatever is at its path; everything else stays.
  /// A missing or non-object parent becomes an object.
  function applyPatch(doc, changes) {
    const d = isObj(doc) ? clone(doc) : {};
    for (const c of changes) {
      let o = d;
      for (const k of c.path.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
      const last = c.path[c.path.length - 1];
      if (c.remove) delete o[last]; else o[last] = clone(c.value);
    }
    return d;
  }

  // ---------- Stamps ----------
  /// Supabase answers in UTC as "…+00:00". A "+" in a query string reads as a space, so stamps are kept as "…Z",
  /// which Postgres reads as the same instant.
  const normalized = s => (typeof s === 'string' && s.endsWith('+00:00') ? s.slice(0, -6) + 'Z' : s ?? null);
  const isUTC = s => typeof s === 'string' && s.endsWith('Z');

  // ---------- The engine ----------
  const MAX_ATTEMPTS = 4;

  /// `store` is any object with loadAll(), load(keys), write(key, data, stamp) and overwrite(docs) (see MemoryStore).
  /// `shape(key, data)` is how the app holds a document (the web app adds a missing `id`); the base is kept in that
  /// shape, so it compares like for like with what the app has.
  class SyncEngine {
    constructor(store, { shape } = {}) {
      this.store = store;
      this.mode = 'merge';          // or 'whole', the old way, set remotely through prefs.syncMode (tools/sync_mode.py)
      this.base = new Map();
      this.shape = shape || ((k, d) => d);
    }

    /// Treats `docs` as what the server has: after a download the app applied. `docs` is a list of { key, data } or a Map.
    adopt(docs) {
      this.base = new Map();
      const entries = docs instanceof Map ? [...docs] : docs.map(d => [d.key, d.data]);
      for (const [k, v] of entries) if (!this.base.has(k)) this.base.set(k, clone(this.shape(k, v)));
    }

    /// Documents in `local` (a Map) that differ from the base, sorted. An empty settings document never counts,
    /// so a device without data can't blank the settings.
    changed(local) {
      const out = [];
      for (const [k, v] of local) {
        if (k === PREFS && (!isObj(v) || !Object.keys(v).some(x => v[x] !== undefined))) continue;
        if (!this.base.has(k) || !same(this.base.get(k), v)) out.push(k);
      }
      return out.sort();
    }

    /// Saves every changed document of `local`. Returns a Map of the documents whose saved version differs from
    /// `local` because another writer's changes were kept; the app shows those instead.
    async push(local) {
      const keys = this.changed(local), adjusted = new Map();
      if (!keys.length) return adjusted;
      if (this.mode === 'whole') {
        const docs = new Map(keys.map(k => [k, clone(local.get(k))]));
        await this.store.overwrite(docs);
        for (const [k, v] of docs) this.base.set(k, v);
        return adjusted;
      }
      const server = await this.store.load(keys);
      for (const k of keys) {
        const mine = clone(local.get(k)), patch = fieldPatch(this.base.get(k) || {}, mine);
        for (let attempt = 1; ; attempt++) {
          const current = server.get(k);
          const merged = current ? applyPatch(current.data, patch) : mine;
          // A row with no stamp still exists: it's updated without the check rather than inserted.
          const r = await this.store.write(k, merged, current ? current.stamp || '' : null);
          if (r.conflict) {
            if (attempt >= MAX_ATTEMPTS) { const { col, id } = split(k); throw new Error(`${col} ${id} kept changing on the server while saving`); }
            const again = (await this.store.load([k])).get(k);
            if (again) server.set(k, again); else server.delete(k);
            continue;
          }
          const shown = clone(this.shape(k, merged));
          this.base.set(k, shown);
          if (!same(shown, mine)) adjusted.set(k, clone(shown));
          break;
        }
      }
      return adjusted;
    }

    /// Everything on the server, as [{ key, data, stamp }]. It becomes the base only once the app applies it (adopt),
    /// so a download that arrives while you have unsaved changes can't make the server's newer values look like your edits.
    fetchAll() { return this.store.loadAll(); }
  }

  // ---------- Stores ----------
  /// A store in memory, for tests. `onLoad` lets a test change the server between a read and a write (it runs once).
  class MemoryStore {
    constructor(initial = {}) {
      this.docs = new Map(); this.counter = 0; this.writes = 0; this.onLoad = null;
      for (const [k, v] of initial instanceof Map ? initial : Object.entries(initial)) this.put(k, v);
    }
    /// Changes a document as another writer (the sync, Claude) would.
    put(k, data) { this.counter += 1; this.docs.set(k, { key: k, data: clone(data), stamp: `v${this.counter}` }); }
    data(k) { return this.docs.get(k)?.data; }
    async loadAll() { return [...this.docs.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(d => clone(d)); }
    async load(keys) {
      const out = new Map(); for (const k of keys) if (this.docs.has(k)) out.set(k, clone(this.docs.get(k)));
      const hook = this.onLoad; this.onLoad = null; if (hook) hook(this);
      return out;
    }
    async write(k, data, stamp) {
      if ((this.docs.get(k)?.stamp ?? null) !== stamp) return { conflict: true };
      this.writes += 1; this.put(k, data);
      return { ok: true, stamp: this.docs.get(k).stamp };
    }
    async overwrite(docs) { for (const [k, v] of docs) { this.writes += 1; this.put(k, v); } }
  }

  /// The docs table through supabase-js. Row-level security limits every request to the signed-in user's rows.
  /// Writes are conditional: update ... where updated_at = <stamp>, returning the row (none back = conflict);
  /// insert, where duplicate key 23505 = conflict. Nothing is ever deleted.
  class SupabaseStore {
    constructor(client, userId) { this.client = client; this.userId = userId; }
    static doc(r) {
      if (!r) return null;
      return { key: key(r.col, r.id), data: isObj(r.data) ? r.data : {}, stamp: normalized(r.updated_at) };
    }
    static fail(error) { const e = new Error(error.message || String(error)); e.code = error.code; return e; }

    async loadAll() {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await this.client.from('docs').select('col,id,data,updated_at').eq('user_id', this.userId)
          .order('col').order('id').range(from, from + 999);
        if (error) throw SupabaseStore.fail(error);
        out.push(...data.map(SupabaseStore.doc));
        if (data.length < 1000) return out;
      }
    }

    async load(keys) {
      const out = new Map(), wanted = new Set(keys), byCol = new Map();
      for (const k of keys) { const { col, id } = split(k); if (!byCol.has(col)) byCol.set(col, []); byCol.get(col).push(id); }
      for (const [col, ids] of byCol) {
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error } = await this.client.from('docs').select('col,id,data,updated_at').eq('user_id', this.userId)
            .eq('col', col).in('id', ids.slice(i, i + 100));
          if (error) throw SupabaseStore.fail(error);
          for (const r of data) { const d = SupabaseStore.doc(r); if (wanted.has(d.key)) out.set(d.key, d); }
        }
      }
      return out;
    }

    /// Writes `data` only if the stored copy still carries `stamp`; null means the document must not exist yet.
    async write(k, data, stamp) {
      const { col, id } = split(k), now = new Date().toISOString();
      if (stamp != null) {
        let q = this.client.from('docs').update({ data, updated_at: now }).eq('user_id', this.userId).eq('col', col).eq('id', id);
        // A stamp that isn't in UTC can't be compared safely; the merge still applies, without the check.
        if (isUTC(stamp)) q = q.eq('updated_at', stamp);
        const { data: rows, error } = await q.select('updated_at');
        if (error) throw SupabaseStore.fail(error);
        if (!rows || !rows.length) return { conflict: true };
        return { ok: true, stamp: normalized(rows[0].updated_at) };
      }
      const { data: rows, error } = await this.client.from('docs').insert({ user_id: this.userId, col, id, data, updated_at: now }).select('updated_at');
      if (error) { if (error.code === '23505') return { conflict: true }; throw SupabaseStore.fail(error); }   // someone created it first
      return { ok: true, stamp: normalized(rows?.[0]?.updated_at) };
    }

    /// The old way: whole documents, last writer wins. Used when the sync switch is set to "whole".
    async overwrite(docs) {
      const now = new Date().toISOString();
      const rows = [...docs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, data]) => ({ user_id: this.userId, ...split(k), data, updated_at: now }));
      for (let i = 0; i < rows.length; i += 400) {
        const { error } = await this.client.from('docs').upsert(rows.slice(i, i + 400), { onConflict: 'user_id,col,id' });
        if (error) throw SupabaseStore.fail(error);
      }
    }
  }

  return { key, split, PREFS, same, clone, fieldPatch, applyPatch, normalized, isUTC, SyncEngine, MemoryStore, SupabaseStore, MAX_ATTEMPTS };
})();
