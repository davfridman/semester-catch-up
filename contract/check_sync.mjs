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

// ---------- The web app's data layer on top (load, edit, push), with the page's scripts in index.html's order ----------
// A page with no DOM: every document call does nothing. Timers never fire; the cases call push() and load() themselves.
const nothing = new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => '' : nothing), apply: () => nothing });
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(x => x[1]).filter(f => f !== 'config.js' && !f.startsWith('vendor/'));
function app(server) {
  const page = vm.createContext({
    window: { APP_CONFIG: {}, supabase: { createClient: () => nothing } }, document: nothing, navigator: {},
    location: { hostname: 'contract-check', search: '' }, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    console, structuredClone,
  });
  for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), page, { filename: f });
  const run = (code, vars = {}) => { Object.assign(page, vars); return vm.runInContext(code, page); };
  const store = new (run('Sync').MemoryStore)(server);
  const toasts = [];
  run(`toast = m => __toasts.push(m); startSync({ id: 'u1', email: 'you@example.com' }); S.user = { id: 'u1', email: 'you@example.com' };
       engine = new Sync.SyncEngine(__store, { shape });`, { __store: store, __toasts: toasts });
  return { run, store, toasts };
}
const item1 = key('item', 'i1'), prefsKey = key('settings', 'prefs');
const appCases = {
  async 'the app loads the server’s documents and writes nothing'() {
    const { run, store } = app({ [item1]: { id: 'i1', c: 'c1', title: 'Ex 1', date: '2026-11-10', status: 'todo' }, [course]: { id: 'c1', name: 'C' }, [prefsKey]: { dateStyle: 'd/M' }, [key('note', 'idea1')]: { id: 'idea1', kind: 'idea' } });
    await run('load()');
    expect('app load: items', run('S.items.map(i => i.id)'), ['i1']);
    expect('app load: prefs', run('S.prefs'), { dateStyle: 'd/M' });
    expect('app load: nothing pending', run('pending()'), false);
    await run('push()');
    expect('app load: no writes', store.writes, 0);
  },
  async 'marking done keeps the sync’s new date, and the app shows it'() {
    const { run, store, toasts } = app({ [item1]: { id: 'i1', title: 'Ex 1', date: '2026-11-10', status: 'todo' } });
    await run('load()');
    store.put(item1, { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'todo' });   // the hourly sync moves the date
    run("setStatus('i1', 'done', false)");
    expect('app done: pending', run('pending()'), true);
    await run('push()');
    expect('app done: saved', store.data(item1), { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'done', doneAt: run('today()') });
    expect('app done: shown', run('item("i1").date'), '2026-11-12');
    expect('app done: nothing pending after', run('pending()'), false);
    expect('app done: no error', toasts, []);
  },
  async 'an edit made during the save stays on top, and is saved next'() {
    const { run, store } = app({ [item1]: { id: 'i1', title: 'Ex 1', date: '2026-11-10', status: 'todo' } });
    await run('load()');
    store.put(item1, { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'todo' });
    run("optimistic('item', 'i1', d => { d.status = 'progress'; return d; })");
    // While the save is reading the server, you write a note.
    store.onLoad = () => run("patch('item', 'i1', x => { x.note = 'left off at 2b'; return x; })");
    await run('push()');
    expect('app during: shown', run('item("i1")'), { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'progress', note: 'left off at 2b' });
    expect('app during: first save', store.data(item1), { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'progress' });
    expect('app during: note pending', run('pending()'), true);
    await run('push()');
    expect('app during: second save', store.data(item1), { id: 'i1', title: 'Ex 1', date: '2026-11-12', status: 'progress', note: 'left off at 2b' });
  },
  async 'a reload with unsaved edits saves them first'() {
    const { run, store } = app({ [course]: { id: 'c1', name: 'C', profile: { color: 'blue' } } });
    await run('load()');
    store.put(course, { id: 'c1', name: 'C', profile: { color: 'blue', rules: ['Claude’s rule'] } });
    run("patch('course', 'c1', d => { d.profile = { ...(d.profile || {}), color: 'red' }; return d; })");
    await run('load()');
    expect('app reload: saved', store.data(course), { id: 'c1', name: 'C', profile: { color: 'red', rules: ['Claude’s rule'] } });
    expect('app reload: shown', run('course("c1")'), store.data(course));
  },
  async 'a download that arrives after an edit doesn’t overwrite it'() {
    const { run, store } = app({ [item1]: { id: 'i1', title: 'Ex 1', status: 'todo' } });
    await run('load()');
    store.put(item1, { id: 'i1', title: 'Ex 1 (renamed)', status: 'todo' });
    // You mark it done while the download is on its way.
    const fetchAll = store.loadAll.bind(store);
    store.loadAll = async () => { const out = await fetchAll(); run("setStatus('i1', 'done', false)"); return out; };
    await run('load()');
    expect('app late download: edit kept', run('item("i1").status'), 'done');
    expect('app late download: base not moved', run('engine.base.get(Sync.key("item", "i1")).title'), 'Ex 1');
    store.loadAll = fetchAll;
    await run('push()');
    expect('app late download: both saved', store.data(item1), { id: 'i1', title: 'Ex 1 (renamed)', status: 'done', doneAt: run('today()') });
  },
  async 'a fresh device with empty settings never blanks them'() {
    const { run, store } = app({ [prefsKey]: { plan: ['i1'], appearance: 'dark' } });
    run('S.prefs = {}');   // as if the settings hadn't arrived yet
    expect('app empty prefs: not pending', run('pending()'), false);
    await run('push()');
    expect('app empty prefs: no writes', store.writes, 0);
  },
  async 'settings change only the key you changed'() {
    const { run, store } = app({ [prefsKey]: { dateStyle: 'd/M', plan: ['i1'] } });
    await run('load()');
    store.put(prefsKey, { dateStyle: 'd/M', plan: ['i1', 'i2'], lastMoodleSync: '2026-11-03T05:00:00Z' });   // the sync and the iPhone app
    run("setPref('appearance', 'dark')");
    await run('push()');
    expect('app prefs: saved', store.data(prefsKey), { dateStyle: 'd/M', plan: ['i1', 'i2'], lastMoodleSync: '2026-11-03T05:00:00Z', appearance: 'dark' });
  },
  async 'a chat message is a new note document'() {
    const { run, store } = app({});
    await run('load()');
    run("S.chatDraft = { text: 'What first?' }; sendChat()");
    await run('push()');
    const notes = [...store.docs.values()].filter(d => d.key.startsWith('note'));
    expect('app chat: one note', notes.length, 1);
    expect('app chat: text', notes[0]?.data.text, 'What first?');
  },
  async 'the sync switch: prefs.syncMode whole saves whole documents'() {
    const { run, store } = app({ [course]: { id: 'c1', profile: { color: 'blue' } }, [prefsKey]: { syncMode: 'whole' } });
    await run('load()');
    store.put(course, { id: 'c1', profile: { color: 'blue', rules: ['r'] } });
    run("patch('course', 'c1', d => { d.profile = { ...(d.profile || {}), color: 'red' }; return d; })");
    await run('push()');
    expect('app whole: overwritten', store.data(course), { id: 'c1', profile: { color: 'red' } });
  },
  async 'a failed save says so and keeps the edit'() {
    const { run, store, toasts } = app({ [item1]: { id: 'i1', status: 'todo' } });
    await run('load()');
    store.write = async () => { throw new Error('offline'); };
    run("setStatus('i1', 'done', false)");
    expect('app offline: push result', await run('push()'), false);
    ok('app offline: toast', toasts.some(t => /Couldn’t save yet: offline/.test(t)));
    expect('app offline: still pending', run('pending()'), true);
    expect('app offline: edit kept', run('item("i1").status'), 'done');
  },
  async 'signing in to another account starts empty, so nothing carries over'() {
    const { run, store } = app({ [item1]: { id: 'i1', status: 'todo' } });
    await run('load()');
    run("setStatus('i1', 'done', false); startSync({ id: 'u2' }); engine = new Sync.SyncEngine(__store2, { shape });", { __store2: new (run('Sync').MemoryStore)() });
    expect('app account: empty', run('[S.items.length, S.courses.length, Object.keys(S.prefs).length]'), [0, 0, 0]);
    expect('app account: nothing pending', run('pending()'), false);
    expect('app account: first account untouched', store.data(item1), { id: 'i1', status: 'todo' });
  },
};
for (const [name, run] of Object.entries({ ...cases, ...appCases })) {
  try { await run(); } catch (x) { fails.push(`${name}: threw ${x.stack || x}`); }
}
console.log(`sync.js: ${count - fails.length}/${count} checks pass (${Object.keys(cases).length} engine cases, ${Object.keys(appCases).length} through the app's data layer: ${scripts.join(', ')})`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
