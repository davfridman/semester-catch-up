// Merge-on-save, checked against an in-memory store: sync.js's fieldPatch, applyPatch and SyncEngine.
//   node contract/check_sync.mjs
// The cases are the iPhone app's FieldPatchTests and SyncEngineTests (semester-ios Tests/SyncEngineTests.swift),
// which simulate Claude, the hourly sync and a change during a save. No dependencies and no network; exits 1 if any fails.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8'), ctx, { filename: 'sync.js' });
const Sync = vm.runInContext('Sync', ctx);
const { key, fieldPatch, applyPatch, SyncEngine, MemoryStore } = Sync;

// Same JSON with sorted keys, so values from the script's realm compare by value.
const canon = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const fails = [];
let count = 0;
const expect = (name, got, want) => { count++; if (canon(got) !== canon(want)) fails.push(`${name}: got ${canon(got)}, expected ${canon(want)}`); };
const ok = (name, cond) => { count++; if (!cond) fails.push(name); };
const map = o => new Map(Object.entries(o));

// ---------- FieldPatchTests ----------
{
  const base = { a: 1, b: 1, profile: { color: 'blue', rules: ['x'] } };
  const local = { a: 1, b: 3, profile: { color: 'red', rules: ['x'] } };
  expect('fieldPatch: changed fields only', fieldPatch(base, local), [{ path: ['b'], value: 3 }, { path: ['profile', 'color'], value: 'red' }]);
}
{
  const p = fieldPatch({ a: 1, gone: 'x' }, { a: 1, new: true });
  expect('fieldPatch: removals and new fields', applyPatch({ a: 2, gone: 'x', other: 'y' }, p), { a: 2, new: true, other: 'y' });
}
expect('fieldPatch: arrays are one field', fieldPatch({ plan: ['i1', 'i2'] }, { plan: ['i2', 'i1'] }), [{ path: ['plan'], value: ['i2', 'i1'] }]);
expect('fieldPatch: nested into a missing parent', applyPatch({}, fieldPatch({ profile: { color: 'blue' } }, { profile: { color: 'red' } })), { profile: { color: 'red' } });
expect('fieldPatch: no change', fieldPatch({ a: 'x' }, { a: 'x' }), []);
// The web app's own additions: a key set to undefined is a removed field, key order doesn't matter, and
// applying a patch never changes the document it was given.
expect('fieldPatch: undefined counts as removed', fieldPatch({ a: 1, doneAt: '2026-11-02' }, { a: 1, doneAt: undefined }), [{ path: ['doneAt'], remove: true }]);
expect('fieldPatch: key order is not a change', fieldPatch({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 }), []);
{
  const doc = { a: { b: 1 } };
  applyPatch(doc, [{ path: ['a', 'b'], value: 2 }]);
  expect('applyPatch: leaves its input alone', doc, { a: { b: 1 } });
}

// ---------- SyncEngineTests ----------
const course = key('course', 'c1'), prefs = key('settings', 'prefs');
async function engine(server) {
  const store = new MemoryStore(server);
  const e = new SyncEngine(store);
  e.adopt(await e.fetchAll());
  return { e, store };
}
const cases = {
  async 'keeps Claude’s rule when you change the color'() {
    const { e, store } = await engine({ [course]: { id: 'c1', profile: { color: 'blue' } } });
    // Claude adds a rule on the server after the app downloaded the course.
    store.put(course, { id: 'c1', profile: { color: 'blue', rules: ['Tutorials repeat the lecture'] } });
    // You change the color in the app.
    const adjusted = await e.push(map({ [course]: { id: 'c1', profile: { color: 'red' } } }));
    const saved = store.data(course);
    expect('keeps rule: saved', saved, { id: 'c1', profile: { color: 'red', rules: ['Tutorials repeat the lecture'] } });
    expect('keeps rule: adjusted', adjusted.get(course), saved);
    expect('keeps rule: base', e.base.get(course), saved);
  },
  async 'retries when the server moves during a save'() {
    const item = key('item', 'i1');
    const { e, store } = await engine({ [item]: { id: 'i1', date: '2026-11-10', status: 'todo' } });
    // The hourly sync moves the date right after the app read the server copy.
    store.onLoad = s => s.put(item, { id: 'i1', date: '2026-11-12', status: 'todo' });
    await e.push(map({ [item]: { id: 'i1', date: '2026-11-10', status: 'done' } }));
    expect('retries: saved', store.data(item), { id: 'i1', date: '2026-11-12', status: 'done' });
  },
  async 'gives up after 4 tries when the server keeps moving'() {
    const item = key('item', 'i1');
    const { e, store } = await engine({ [item]: { id: 'i1', status: 'todo' } });
    let n = 0;
    const realLoad = store.load.bind(store);
    store.load = async keys => { const out = await realLoad(keys); store.put(item, { id: 'i1', status: 'todo', n: ++n }); return out; };
    let error = null;
    try { await e.push(map({ [item]: { id: 'i1', status: 'done' } })); } catch (x) { error = x; }
    ok('gives up: throws', error && /kept changing/.test(error.message));
    expect('gives up: reads', n, 4);
    expect('gives up: nothing written', store.writes, 0);
  },
  async 'a new document is created'() {
    const { e, store } = await engine({});
    const note = key('note', 'n1');
    const adjusted = await e.push(map({ [note]: { id: 'n1', kind: 'chat', text: 'hi' } }));
    expect('new document: saved', store.data(note)?.text, 'hi');
    expect('new document: not adjusted', adjusted.size, 0);
  },
  async 'a document someone else just created is merged, not overwritten'() {
    const { e, store } = await engine({});
    const note = key('note', 'n1');
    // Another writer creates the same document between the read and the insert: the insert is refused (23505).
    store.onLoad = s => s.put(note, { id: 'n1', kind: 'chat', text: 'theirs', seen: true });
    const adjusted = await e.push(map({ [note]: { id: 'n1', kind: 'chat', text: 'mine' } }));
    expect('created first: saved', store.data(note), { id: 'n1', kind: 'chat', text: 'mine', seen: true });
    expect('created first: adjusted', adjusted.get(note), store.data(note));
  },
  async 'empty settings never overwrite'() {
    const { e, store } = await engine({ [prefs]: { plan: ['i1'] } });
    expect('empty settings: not changed', e.changed(map({ [prefs]: {} })), []);
    await e.push(map({ [prefs]: {} }));
    expect('empty settings: no writes', store.writes, 0);
  },
  async 'unchanged documents aren’t written'() {
    const { e, store } = await engine({ [course]: { id: 'c1' } });
    await e.push(map({ [course]: { id: 'c1' } }));
    expect('unchanged: no writes', store.writes, 0);
  },
  async 'whole mode is the old way'() {
    const { e, store } = await engine({ [course]: { id: 'c1', profile: { color: 'blue' } } });
    store.put(course, { id: 'c1', profile: { color: 'blue', rules: ['r'] } });
    e.mode = 'whole';
    await e.push(map({ [course]: { id: 'c1', profile: { color: 'red' } } }));
    expect('whole mode: saved', store.data(course), { id: 'c1', profile: { color: 'red' } });
  },
  async 'downloading doesn’t move the base'() {
    const { e, store } = await engine({ [course]: { id: 'c1', name: 'Old' } });
    store.put(course, { id: 'c1', name: 'New' });
    await e.fetchAll();
    // Until the app applies the download, the base is still what the app last saw, so your edit stays your edit.
    expect('download: base', e.base.get(course), { id: 'c1', name: 'Old' });
    await e.push(map({ [course]: { id: 'c1', name: 'Old', short: 'C1' } }));
    expect('download: saved', store.data(course), { id: 'c1', name: 'New', short: 'C1' });
  },
  async 'a removed field is removed on the server, and only that one'() {
    const item = key('item', 'i1');
    const { e, store } = await engine({ [item]: { id: 'i1', status: 'done', doneAt: '2026-11-01' } });
    store.put(item, { id: 'i1', status: 'done', doneAt: '2026-11-01', date: '2026-11-05' });
    await e.push(map({ [item]: { id: 'i1', status: 'todo' } }));
    expect('removed field: saved', store.data(item), { id: 'i1', status: 'todo', date: '2026-11-05' });
  },
  async 'the shape the app holds documents in is the base’s shape'() {
    // The web app gives a document without data.id its row id; that alone isn't an edit, and isn't written.
    const item = key('item', 'i1');
    const store = new MemoryStore({ [item]: { title: 'T' } });
    const e = new SyncEngine(store, { shape: (k, d) => (d.id ? d : { ...d, id: Sync.split(k).id }) });
    e.adopt(await e.fetchAll());
    await e.push(map({ [item]: { title: 'T', id: 'i1' } }));
    expect('shape: no writes', store.writes, 0);
    const adjusted = await e.push(map({ [item]: { title: 'T', id: 'i1', status: 'done' } }));
    expect('shape: only the change is written', store.data(item), { title: 'T', status: 'done' });
    expect('shape: not adjusted', adjusted.size, 0);
  },
  async 'only the documents you changed are written'() {
    const a = key('item', 'a'), b = key('item', 'b');
    const { e, store } = await engine({ [a]: { id: 'a', status: 'todo' }, [b]: { id: 'b', status: 'todo' } });
    await e.push(map({ [a]: { id: 'a', status: 'done' }, [b]: { id: 'b', status: 'todo' } }));
    expect('only changed: writes', store.writes, 1);
    expect('only changed: untouched', store.data(b), { id: 'b', status: 'todo' });
  },
};

for (const [name, run] of Object.entries(cases)) {
  try { await run(); } catch (x) { fails.push(`${name}: threw ${x.stack || x}`); }
}
console.log(`sync.js: ${count - fails.length}/${count} checks pass (${Object.keys(cases).length} engine cases)`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
