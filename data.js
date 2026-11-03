// The data layer: the only file that talks to storage. Data lives in Supabase (table docs: user_id, col, id, data,
// updated_at); demo mode reads an exported file instead. Saving goes through sync.js (merge-on-save). Safety rules:
// - Never delete a row. Hidden items stay in the data with hidden: true.
// - Save only the fields you changed, on top of the server's current copy, and only if nobody wrote in between,
//   so an edit here never overwrites what the iPhone app, the syncs or Claude changed in the meantime.
// Screens learn about changes through dataEvents (router.js sets them): `changed` redraws, `message` shows a toast.
'use strict';

const CFG = window.APP_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
// The app's state: the signed-in user and the documents (courses, items, prefs…), plus where you are (tab, route,
// list, courseTab, day, sheet), which the router and the screens keep.
const S = { user: null, courses: [], items: [], prefs: {}, questions: [], updates: [], insights: [], chat: [], loaded: false,
  tab: 'overview', route: [], list: 'plan', courseTab: 'tasks', day: null, sheet: null };
// Local testing only: ?demo=file.json on localhost shows an exported copy without signing in; nothing is saved.
const DEMO = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('demo');

// ---------- Loading and saving ----------
// Saving merges (sync.js): only the fields you changed go on top of the server's current copy, written only if
// nobody wrote in between. The engine is made at sign-in; demo mode has none, so it never writes.
const dataEvents = { changed() {}, message() {} };
let engine = null, pushing = null, pushAgain = false, pushTimer = null, retryTimer = null, renderAfterSave = false;
const lists = () => ({ course: S.courses, item: S.items, question: S.questions, update: S.updates, insight: S.insights, note: S.chat });
// How the app holds a document: with its row id when data.id is missing (settings stay as they are).
const shape = (k, d) => { const { col, id } = Sync.split(k), o = d && typeof d === 'object' && !Array.isArray(d) ? d : {}; return col === 'settings' || o.id ? o : { ...o, id }; };
function startSync(user) {
  clearTimeout(pushTimer); clearTimeout(retryTimer); renderAfterSave = false;
  // A new account starts empty, so nothing of the previous one can look like an edit and be saved into it.
  Object.assign(S, { courses: [], items: [], prefs: {}, questions: [], updates: [], insights: [], chat: [], loaded: false });
  engine = user && !DEMO ? new Sync.SyncEngine(new Sync.SupabaseStore(sb, user.id), { shape }) : null;
}
/// Every document the web app keeps in step with the server (non-chat notes aren't kept, so they're never written).
function docMap() {
  const m = new Map();
  for (const [col, list] of Object.entries(lists())) for (const d of list) m.set(Sync.key(col, d.id), d);
  m.set(Sync.PREFS, S.prefs);
  return m;
}
const pending = () => !!engine && engine.changed(docMap()).length > 0;
/// Puts one document back into the app, e.g. after a save kept someone else's change in it.
function setDoc(k, o) {
  const { col, id } = Sync.split(k);
  if (col === 'settings') { if (id === 'prefs') S.prefs = o; return; }
  if (col === 'note' && o.kind !== 'chat') return;
  const list = lists()[col]; if (!list) return;
  const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = o; else list.push(o);
}
async function load() {
  if (DEMO) {
    const o = await (await fetch(DEMO)).json();
    Object.assign(S, { courses: o.courses || [], items: o.items || [], questions: o.questions || [], updates: o.updates || [], insights: o.insights || [], chat: o.chat || [], prefs: o.prefs || {}, loaded: true });
    return dataEvents.changed();
  }
  if (!engine) return;
  const e = engine;
  // Unsaved changes stay on screen: save them first, and never let a download overwrite them.
  if (pushing) await pushing;
  if (pending() && !(await push())) return;
  let docs;
  try { docs = await e.fetchAll(); } catch (err) { dataEvents.message(`Couldn’t load: ${err.message}`); return; }
  if (e !== engine || pending()) return;   // signed out, or changed while loading: the next load picks it up after the save
  const by = { course: [], item: [], question: [], update: [], insight: [], note: [] }; let prefs = {};
  for (const d of docs) {
    const { col, id } = Sync.split(d.key);
    if (col === 'settings' && id === 'prefs') prefs = shape(d.key, d.data);
    else if (by[col]) by[col].push(shape(d.key, d.data));
  }
  // The app's copy and the base are separate copies: the app changes its documents in place.
  const own = o => Sync.clone(o);
  const chat = by.note.filter(n => n.kind === 'chat').sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  Object.assign(S, { courses: by.course.map(own), items: by.item.map(own), questions: by.question.map(own), updates: by.update.map(own), insights: by.insight.map(own), chat: chat.map(own), prefs: own(prefs), loaded: true });
  e.adopt(docs);
  dataEvents.changed();
}
/// Saves every changed document (sync.js). Returns false if it couldn't, and tries again in 10 seconds.
async function push() {
  if (DEMO || !engine) { if (renderAfterSave) { renderAfterSave = false; dataEvents.changed(); } return true; }
  if (pushing) { pushAgain = true; return pushing; }
  const e = engine;
  pushing = (async () => {
    try {
      // The sync switch (tools/sync_mode.py): prefs.syncMode "whole" goes back to saving whole documents.
      e.mode = S.prefs.syncMode === 'whole' ? 'whole' : 'merge';
      const local = docMap(), sent = new Map(e.changed(local).map(k => [k, Sync.clone(local.get(k))]));
      // Rows are only added or updated; nothing is ever deleted (the apps hide items instead).
      const adjusted = sent.size ? await e.push(sent) : new Map();
      if (e !== engine) return true;
      // A save that kept another writer's changes: show the saved version, with any edit you made meanwhile on top.
      if (adjusted.size) {
        const now = docMap();
        for (const [k, saved] of adjusted) {
          const mine = now.get(k) ?? sent.get(k);
          setDoc(k, Sync.same(mine, sent.get(k)) ? saved : Sync.applyPatch(saved, Sync.fieldPatch(sent.get(k), mine)));
        }
      }
      if (adjusted.size || renderAfterSave) { renderAfterSave = false; dataEvents.changed(); }
      return true;
    } catch (err) {
      dataEvents.message(`Couldn’t save yet: ${err.message}. Trying again…`);
      clearTimeout(retryTimer); retryTimer = setTimeout(push, 10000);
      return false;
    }
  })();
  const ok = await pushing;
  pushing = null;
  if (pushAgain) { pushAgain = false; schedulePush(); }
  return ok;
}
/// Saves what's waiting right away (the page is being left).
function saveNow() { if (pending()) push(); }
/// Saves shortly after a change, so a burst of changes (Mark all seen) goes out together.
function schedulePush(ms = 250) { clearTimeout(pushTimer); pushTimer = setTimeout(push, ms); }
/// Changes one document here and saves it. `change` edits the document in place, or returns a new one.
/// Course and item documents are only changed when the app has them; nothing new is made up for them.
function edit(col, id, change) {
  if (col === 'settings') { if (id !== 'prefs') return; const next = change(S.prefs); if (next && next !== S.prefs) S.prefs = next; }
  else {
    const list = lists()[col]; if (!list) return;
    let i = list.findIndex(d => d.id === id);
    if (i < 0) { if (col === 'item' || col === 'course') return; list.push({ id }); i = list.length - 1; }
    const next = change(list[i]); if (next && next !== list[i]) list[i] = next;
  }
  schedulePush();
}
/// Change and save; the screen redraws once the save is done (like before, so a tap that ended a text edit still lands).
function patch(col, id, change) { edit(col, id, change); renderAfterSave = true; }
// Show the change right away, then save it.
function optimistic(col, id, change) { edit(col, id, change); dataEvents.changed(); }

// ---------- Account ----------
// Signing in and out. A change of account starts the sync engine for it (startSync) and downloads.
const signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
const resetPassword = email => sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
const signOut = () => sb.auth.signOut();
/// Calls `onUser()` when someone else signs in, or you sign out (S.user is then null). Demo mode is signed in as
/// "demo" from the start and loads its file right away.
function watchAccount(onUser) {
  if (DEMO) { S.user = { id: 'demo', email: 'demo' }; load(); return; }
  sb.auth.onAuthStateChange((_e, session) => {
    const was = S.user?.id; S.user = session?.user || null;
    if (!S.user) { startSync(null); return onUser(); }
    if (was !== S.user.id) { startSync(S.user); onUser(); }
  });
}
