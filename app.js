// Semester Catch-Up for the web: the same data and design as the iPhone app, for any device.
// Data lives in Supabase (table docs: user_id, col, id, data). Safety rules, learned the hard way:
// - Never delete a row. Hidden items stay in the data with hidden: true.
// - Change one document at a time: read its newest copy, change the fields you touched, write it back.
//   So an edit here never overwrites what the iPhone app or the syncs changed in the meantime.
'use strict';

const CFG = window.APP_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- State ----------
const S = { user: null, courses: [], items: [], prefs: {}, questions: [], updates: [], insights: [], loaded: false,
  tab: 'overview', route: [], list: 'plan', courseTab: 'tasks', day: null, sheet: null };
const SESSION_TYPES = new Set(['Lecture', 'Tutorial', 'Online unit']);
const COLORS = ['blue', 'purple', 'pink', 'teal', 'indigo', 'orange', 'cyan', 'brown'];

// ---------- Dates (local time, like the app) ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => (s && s.length === 10 ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
const today = () => iso(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nowHHmm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dm(s) {
  const d = typeof s === 'string' ? parse(s) : s; if (!d) return '';
  const day = d.getDate(), m = d.getMonth();
  switch (S.prefs.dateStyle) {
    case 'd MMM': return `${day} ${MONTHS[m]}`;
    case 'MMM d': return `${MONTHS[m]} ${day}`;
    case 'd/M': return `${day}/${m + 1}`;
    case 'd.M': return `${day}.${m + 1}`;
    default: return `${day}/${MONTHS[m]}`;
  }
}
const dow = s => { const d = parse(s); return d ? DOW[d.getDay()] : ''; };
const dayLabel = s => (S.prefs.showWeekday === false || !parse(s) ? dm(s) : `${dow(s)} ${dm(s)}`);
function ago(t) {
  const d = new Date(t); if (isNaN(d)) return '';
  const m = Math.max(0, (Date.now() - d) / 6e4);
  if (m < 1) return 'just now'; if (m < 60) return `${Math.floor(m)} min ago`;
  const h = m / 60; if (h < 24) { const n = Math.round(h); return n === 1 ? '1 hour ago' : `${n} hours ago`; }
  const n = Math.round(h / 24); return n === 1 ? 'yesterday' : `${n} days ago`;
}
const longDate = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// ---------- Models ----------
const isSession = it => SESSION_TYPES.has(it.type);
const status = it => it.status || 'todo';
const isHandled = it => ['done', 'skip', 'attended', 'reviewed'].includes(status(it));
const inProgress = it => status(it) === 'progress';
const course = id => S.courses.find(c => c.id === id);
const item = id => S.items.find(i => i.id === id);
const profile = c => (c && c.profile) || {};
const short = c => (c ? c.short || (c.name || '').slice(0, 4).toUpperCase() : '');
function displayName(c) {
  if (!c) return '';
  if (profile(c).nickname) return profile(c).nickname;
  let cut = (c.name || '').split(/[,&:]/)[0];
  for (const p of ['Introduction and Topics in ', 'Introduction to ', 'Intro to ']) if (cut.startsWith(p)) { cut = cut.slice(p.length); break; }
  return cut.trim();
}
function colorName(id) {
  const c = course(id); if (c && profile(c).color) return profile(c).color;
  const idx = [...S.courses].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).findIndex(x => x.id === id);
  return COLORS[Math.max(0, idx) % COLORS.length];
}
const color = id => (course(id) ? `var(--c-${colorName(id)})` : 'var(--label2)');
const visibleCourses = () => S.courses.filter(c => !profile(c).hidden).sort((a, b) => (profile(a).rank ?? 1000) - (profile(b).rank ?? 1000) || (a.order ?? 99) - (b.order ?? 99));
const visibleItems = () => { const hid = new Set(S.courses.filter(c => profile(c).hidden).map(c => c.id)); return S.items.filter(i => !i.hidden && !hid.has(i.c)); };
const isExam = it => !isSession(it) && (it.type === 'Exam' || /exam|midterm|final|מבחן|בחינה/i.test(it.title || ''));
const isGate = it => /required|gate/i.test(it.note || '');
const fmt = v => (v === Math.round(v) ? String(v) : v.toFixed(1));

function state(it, now = new Date()) {
  const s = baseState(it, now);
  if (!inProgress(it) || s.key === 'closed' || s.key === 'open') return s;
  return { key: s.key, text: isSession(it) ? 'In progress' : `In progress · ${s.text.toLowerCase()}` };
}
function baseState(it, now) {
  const t = iso(now), st = status(it);
  if (st === 'done') return { key: 'done', text: isSession(it) ? 'Watched' : 'Done' };
  if (st === 'attended') return { key: 'done', text: 'Attended' };
  if (st === 'reviewed') return { key: 'reviewed', text: isSession(it) ? 'Skimmed' : 'Went over it' };
  if (st === 'skip') return { key: 'wont', text: isSession(it) ? 'Won’t watch' : 'Won’t do' };
  if (isSession(it)) {
    if (it.date > t) return { key: 'open', text: 'Upcoming' };
    const a = parse(it.date) ? daysBetween(parse(it.date), now) : 0;
    return { key: 'watch', text: a === 0 ? 'Today' : a === 1 ? 'Yesterday' : `${a} days behind` };
  }
  if (it.opens && it.opens > t) return { key: 'open', text: `Opens ${dm(it.opens)}` };
  const n = parse(it.date) ? daysBetween(now, parse(it.date)) : 0;
  const passed = n < 0 || (n === 0 && it.time && it.time < nowHHmm());
  if (passed && it.optional) return { key: 'open', text: 'Not taken' };   // an exam's Moed B, for example
  if (passed) return { key: 'closed', text: 'Missed' };
  if (n <= 3) return { key: 'due', text: n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : `Due ${dow(it.date)}` };
  return { key: 'todo', text: `Due ${dm(it.date)}` };
}
const isOpenish = it => ['todo', 'due', 'watch'].includes(state(it).key);
function importance(it) {
  const w = it.weight || 0;
  const base = it.type === 'Exam' || isGate(it) || w >= 10 ? 3 : w >= 3 || it.type === 'Project' ? 2 : 1;
  return Math.min(3, Math.max(1, base + (it.myImportance || 0)));
}
function rankedTasks(items) {
  const goal = { pass: 0.8, good: 1, top: 1.25 }, f = {};
  const ranked = S.courses.filter(c => profile(c).rank != null).sort((a, b) => profile(a).rank - profile(b).rank);
  for (const c of S.courses) f[c.id] = goal[profile(c).goal] ?? 1;
  ranked.forEach((c, i) => { if (ranked.length > 1) f[c.id] *= 1.15 - 0.3 * i / (ranked.length - 1); });
  const score = it => {
    const d = parse(it.date) ? daysBetween(new Date(), parse(it.date)) : 99;
    const u = d <= 1 ? 4 : d <= 3 ? 3 : d <= 7 ? 2 : d <= 14 ? 1 : 0.5;
    return (u * (1 + importance(it) * 1.5) + (it.weight || 0) / 10) * (f[it.c] ?? 1);
  };
  return items.filter(i => !isSession(i) && isOpenish(i)).sort((a, b) => score(b) - score(a));
}
function catchUp(items) {
  const t = today(); let handled = 0, total = 0, behind = 0;
  for (const it of items) {
    if (!it.date || (it.optional && !isHandled(it))) continue;
    const happened = isSession(it) ? it.date <= t : it.date < t || state(it).key === 'closed';
    if (!happened) continue;
    const w = importance(it); total += w;
    if (isHandled(it)) handled += status(it) === 'reviewed' ? w / 2 : w; else if (isSession(it)) behind++;
  }
  const fraction = total > 0 ? handled / total : null;
  return { fraction, behind, percent: fraction == null ? '—' : `${Math.round(fraction * 100)}%` };
}
function weeks() {
  const start = parse(S.prefs.semStart) || parse('2026-10-11');
  let count = 15;
  if (parse(S.prefs.semEnd)) count = Math.max(1, Math.ceil((daysBetween(start, parse(S.prefs.semEnd)) + 1) / 7));
  return Array.from({ length: count }, (_, i) => { const s = addDays(start, i * 7); return { n: i + 1, ws: iso(s), we: iso(addDays(s, 6)) }; });
}
const currentWeek = () => { const t = today(), w = weeks(); return w.find(x => t >= x.ws && t <= x.we) || (t < w[0].ws ? w[0] : w[w.length - 1]); };
const planIDs = () => (S.prefs.plan || []).filter(id => item(id));
const planItems = () => planIDs().map(item).filter(i => i && !i.hidden);
const attendance = its => { const held = its.filter(i => isSession(i) && i.type !== 'Online unit' && i.date <= today()); return { attended: held.filter(i => status(i) === 'attended').length, held: held.length }; };
const isRTL = s => { let r = 0, l = 0; for (const ch of String(s || '')) { if (/[֐-ࣿיִ-﷿]/.test(ch)) r++; else if (/\p{L}/u.test(ch)) l++; } return r > l; };
const seconds = s => String(s || '').split(':').map(Number).filter(n => !isNaN(n)).reduce((a, b) => a * 60 + b, 0);
const clock = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };

// ---------- Data ----------
// Local testing only: ?demo=file.json on localhost shows an exported copy without signing in; nothing is saved.
const DEMO = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('demo');
async function load() {
  if (DEMO) {
    const o = await (await fetch(DEMO)).json();
    Object.assign(S, { courses: o.courses || [], items: o.items || [], questions: o.questions || [], updates: o.updates || [], insights: o.insights || [], prefs: o.prefs || {}, loaded: true });
    applyTheme(); return render();
  }
  const { data, error } = await sb.from('docs').select('col,id,data').eq('user_id', S.user.id).range(0, 9999);
  if (error) { toast(`Couldn’t load: ${error.message}`); return; }
  const by = { course: [], item: [], question: [], update: [], insight: [] }; let prefs = {};
  for (const r of data) {
    if (r.col === 'settings' && r.id === 'prefs') prefs = r.data || {};
    else if (by[r.col]) by[r.col].push({ ...r.data, id: r.data?.id || r.id });
  }
  Object.assign(S, { courses: by.course, items: by.item, questions: by.question, updates: by.update, insights: by.insight, prefs, loaded: true });
  applyTheme();
  render();
}

/// Read the newest copy of one document, change it, write it back.
async function patch(col, id, change) {
  if (DEMO) return render();
  const { data: rows, error } = await sb.from('docs').select('data').eq('user_id', S.user.id).eq('col', col).eq('id', id).limit(1);
  if (error) { toast(`Not saved: ${error.message}`); return; }
  const cur = rows?.[0]?.data || { id };
  const next = change(structuredClone(cur)) || cur;
  const { error: e2 } = await sb.from('docs').upsert({ user_id: S.user.id, col, id, data: next }, { onConflict: 'user_id,col,id' });
  if (e2) { toast(`Not saved: ${e2.message}`); return; }
  const list = { course: S.courses, item: S.items, question: S.questions, update: S.updates, insight: S.insights }[col];
  if (col === 'settings' && id === 'prefs') S.prefs = next;
  else if (list) { const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = next; else list.push(next); }
  render();
}
// Show the change right away, then save it.
function optimistic(col, id, change) {
  const list = { item: S.items, update: S.updates, insight: S.insights, question: S.questions }[col];
  if (col === 'settings') change(S.prefs); else { const x = list?.find(d => d.id === id); if (x) change(x); }
  render();
  return patch(col, id, change);
}
const setPref = (k, v) => optimistic('settings', 'prefs', p => { if (v == null) delete p[k]; else p[k] = v; return p; });

function setStatus(id, value, announce = true) {
  const it = item(id); if (!it) return;
  const before = status(it); if (before === value) return;
  optimistic('item', id, d => { d.status = value; if (value === 'done' || value === 'attended') d.doneAt = today(); else delete d.doneAt; return d; });
  if (!announce) return;
  const words = { done: isSession(it) ? 'watched' : 'done', attended: 'attended', progress: 'in progress', reviewed: isSession(it) ? 'skimmed' : 'went over it',
    skip: isSession(it) ? 'won’t watch' : 'won’t do', todo: isSession(it) ? 'back to to watch' : 'back to to do' };
  toast(`${it.title} ${words[value] || value}`, () => setStatus(id, before, false));
  if (['done', 'attended', 'reviewed'].includes(value) && S.prefs.askReflection !== false && !it.reflection) setTimeout(() => openSheet({ kind: 'reflect', id }), 500);
}
const inPlan = id => planIDs().includes(id);
const togglePlan = id => setPref('plan', inPlan(id) ? planIDs().filter(x => x !== id) : [...planIDs(), id]);
const markSeen = ids => ids.forEach(id => optimistic('update', id, d => { d.seen = true; return d; }));

// ---------- Feed ----------
const unseenUpdates = () => S.updates.filter(u => !u.seen).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
const activeClaude = () => { const week = Date.now() - 7 * 864e5; return S.insights.filter(i => i.kind !== 'brief' && !i.dismissed && new Date(i.at || 0) >= week).sort((a, b) => (b.at || '').localeCompare(a.at || '')); };
const UPDATE_META = { warning: ['⚠︎', 'Needs attention'], claude: ['✦', 'Claude changed'], new: ['＋', 'New'], date: ['◷', 'Date changed'], recording: ['▶︎', 'New recording'], submitted: ['✓', 'Submitted'], announcement: ['📣', 'Announcement'] };
function feedCards() {
  const cards = [];
  const lastGood = S.prefs.lastMoodleSync ? new Date(S.prefs.lastMoodleSync) : null;
  const order = { warning: 0, claude: 1 };
  const fresh = unseenUpdates().filter(u => u.kind !== 'announcement' && !(u.kind === 'warning' && lastGood && new Date(u.at || 0) < lastGood));
  fresh.sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2));
  for (const u of fresh) { const [sym, label] = UPDATE_META[u.kind] || ['•', 'Update']; cards.push({ id: 'u:' + u.id, kind: 'update', sym, label, text: u.text, detail: u.detail, course: u.course, item: u.item, at: u.at, link: u.link, u }); }
  for (const i of activeClaude().slice(0, 6)) cards.push({ id: 'c:' + i.id, kind: 'claude', sym: i.about?.length ? '📣' : '✦', label: i.about?.length ? 'From an announcement' : 'Claude noticed', text: i.text, course: i.course, at: i.at, about: i.about || [], i });
  return cards;
}
function seenCard(c) {
  if (c.kind === 'update') markSeen([c.u.id]);
  else if (c.kind === 'claude') optimistic('insight', c.i.id, d => { d.dismissed = true; return d; });
}

// ---------- Rendering helpers ----------
const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ROW_ICONS = {
  cap: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>'),
  play: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>'),
  megaphone: svg('<path d="M3 10v4h4l8 4V6L7 10z"/><path d="M18 9a4 4 0 010 6"/>'),
  doc: svg('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  note: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
};
// What you wrote yourself: a note you typed (the sync's own notes don't count) and what you said about how it went.
const yourNote = it => (it.locked || []).includes('note') ? (it.note || '').trim() : '';
const reflectionNote = it => it.reflection?.note || '';
const hasYourNotes = it => !!(yourNote(it) || reflectionNote(it));
const ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="13" r="8"/><path d="M12 13l4-4" stroke-linecap="round"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><text x="2.5" y="8" font-size="6" fill="currentColor" stroke="none">1</text><text x="2.5" y="14" font-size="6" fill="currentColor" stroke="none">2</text><text x="2.5" y="20" font-size="6" fill="currentColor" stroke="none">3</text></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
};
function ring(fraction, size, width, col) {
  const r = (size - width) / 2, c = 2 * Math.PI * r, f = fraction ?? 0;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--fill2)" stroke-width="${width}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
const ringWithText = (fraction, size, width, col, text, fs) => `<div style="position:relative;width:${size}px;height:${size}px">${ring(fraction, size, width, col)}<div style="position:absolute;inset:0;display:grid;place-items:center;font-size:${fs}px;font-weight:700">${esc(text)}</div></div>`;
const CIRCLE = { todo: ['', ''], due: ['', ''], watch: ['', ''], open: ['', 'locked'], done: ['✓', 'filled'], reviewed: ['~', 'filled'], wont: ['✕', ''], closed: ['!', 'filled'] };

/// A card: title and one time cue, then a quiet line of tags and the course (DESIGN.md, Card anatomy).
function card(it, { trailing = 'date', showCourse = true, showPlanTag = true, title } = {}) {
  const st = state(it), key = st.key, open = ['todo', 'due', 'watch'].includes(key);
  const col = key === 'open' ? 'var(--label3)' : key === 'closed' || key === 'wont' ? 'var(--red)' : color(it.c);
  const [g, cls] = inProgress(it) && open ? ['◐', ''] : CIRCLE[key] || ['', ''];
  let cue, strong = false;
  if (trailing === 'time') cue = it.time || 'All day';
  else if (key === 'open') cue = st.text;
  else if (!open) cue = st.text;
  else if (isSession(it)) { const n = parse(it.date) ? daysBetween(parse(it.date), new Date()) : 0; cue = n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days behind`; }
  else { const n = parse(it.date) ? daysBetween(new Date(), parse(it.date)) : 99; cue = n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? dow(it.date) : dm(it.date); strong = n <= 1; }
  const cueColor = !open && key !== 'open' ? (key === 'done' ? 'var(--green)' : key === 'reviewed' ? 'var(--mint)' : 'var(--red)') : '';
  const tags = [];
  if (open && isExam(it)) tags.push('<span class="tag strong">Exam</span>');
  const pi = planIDs().indexOf(it.id);
  if (open && showPlanTag && pi >= 0) tags.push(`<span class="tag" aria-label="Number ${pi + 1} in your plan">≡ ${pi + 1}</span>`);
  const extra = [];
  if (trailing === 'time' || !showCourse) { if (!(open && isExam(it))) extra.push(esc(it.type)); }
  if (it.weight > 0) extra.push(`${fmt(it.weight)}%`);
  if (it.grade != null && isHandled(it)) extra.push(`grade ${fmt(it.grade)}`);
  const c = course(it.c);
  const ctx = (showCourse && c ? `<span style="color:${color(it.c)}">${esc(displayName(c))}</span>${extra.length ? ' · ' : ''}` : '') + extra.join(' · ');
  const watched = Math.floor(seconds(it.stopAt) / 60), dur = it.duration || 90;
  const progress = isSession(it) && it.stopAt && !isHandled(it) ? `<div class="bar"><i style="width:${Math.min(100, watched / dur * 100)}%;background:${color(it.c)}"></i></div>` : '';
  const note = inProgress(it) && it.note ? `<div class="l2" style="font-size:12px">✎ ${esc(it.note.split('\n')[0])}</div>` : '';
  const bg = key === 'done' ? 'done' : key === 'reviewed' ? 'reviewed' : key === 'closed' || key === 'wont' ? 'missed' : '';
  return `<div class="card ${bg}" data-open="${esc(it.id)}" role="button" tabindex="0">
    <button class="circle ${cls}" style="color:${col}" data-toggle="${esc(it.id)}" aria-label="${isHandled(it) ? 'Mark as not done' : isSession(it) ? 'Mark watched' : 'Mark done'}" ${key === 'open' ? 'disabled' : ''}><span>${g}</span></button>
    <div class="cbody"><div class="l1"><div class="title ${open ? '' : 'dim'}" dir="auto">${esc(title || it.title)}</div><div class="cue ${strong ? 'strong' : ''}" style="${cueColor ? `color:${cueColor};font-weight:500` : ''}">${esc(cue)}</div></div>
    <div class="l2">${tags.join('')}<span style="overflow:hidden;text-overflow:ellipsis">${ctx}</span>${hasYourNotes(it) && !note ? '<span class="note-badge" aria-label="Has your note">✎</span>' : ''}</div>${progress}${note}</div></div>`;
}
const cardsOr = (list, empty, opts) => (list.length ? `<div class="cards">${list.map(i => card(i, opts)).join('')}</div>` : `<div class="empty">${esc(empty)}</div>`);
const seg = (name, options, current) => `<div class="seg" role="tablist">${options.map(([v, l]) => `<button role="tab" class="${v === current ? 'on' : ''}" data-seg="${name}" data-val="${v}">${esc(l)}</button>`).join('')}</div>`;

// ---------- Screens ----------
function overview() {
  const items = visibleItems(), s = catchUp(items), w = currentWeek();
  const courses = visibleCourses(), n = courses.length, cols = n <= 4 ? Math.max(n, 1) : [5, 6, 9].includes(n) ? 3 : 4;
  const tasks = rankedTasks(items), lectures = items.filter(i => isSession(i) && isOpenish(i)).sort((a, b) => (inProgress(a) ? 0 : 1) - (inProgress(b) ? 0 : 1) || a.date.localeCompare(b.date));
  const plan = planItems().filter(i => !isHandled(i)), cards = feedCards(), qs = S.questions.filter(q => (q.status || 'open') === 'open');
  const list = S.list === 'plan' ? cardsOr(plan.slice(0, 8), 'Nothing planned. Open a task and tap the plan button.', { showPlanTag: false })
    : S.list === 'tasks' ? cardsOr(tasks, 'Nothing open right now.') : cardsOr(lectures, 'You’re caught up on lectures.');
  return `<div class="head"><div><div class="sub">${esc(longDate())}</div><h1>Overview</h1></div><button class="hbtn" data-go="notes" aria-label="Your notes" title="Your notes">${ROW_ICONS.note}</button></div>
  <div class="group pad"><button class="rings-top" style="width:100%" data-go="progress"><b>${s.percent}</b><span style="color:var(--label2);font-size:15px">caught up</span><span style="flex:1"></span><span style="color:var(--label2);font-size:15px">Week ${w.n} of ${weeks().length}</span></button>
    <div class="rings" style="grid-template-columns:repeat(${cols},1fr)">${courses.map(c => { const cs = catchUp(items.filter(i => i.c === c.id)); return `<button class="ring-item" data-course="${esc(c.id)}" aria-label="${esc(displayName(c))}, ${cs.percent} caught up">${ringWithText(cs.fraction, 52, 6, color(c.id), cs.percent, 11)}<span class="name" style="color:${color(c.id)}">${esc(short(c))}</span><span class="meta">${cs.behind ? `${cs.behind} to watch` : 'caught up'}</span></button>`; }).join('')}</div></div>
  ${qs.length ? `<button class="group pad qbanner" style="width:100%;text-align:left" data-sheet="questions"><span class="spark">✦</span><span class="grow"><b>${qs.length === 1 ? 'Claude has a question' : `Claude has ${qs.length} questions`}</b><br><span style="color:var(--label2);font-size:15px">A few taps help Claude rank things for you</span></span><span style="color:var(--accent);font-weight:600">Answer</span></button>` : ''}
  <div class="feed-head"><h3>For you</h3><button style="color:var(--accent);font-weight:600;font-size:15px" data-go="feed">${cards.length ? `${cards.length} new ›` : 'History ›'}</button></div>
  ${cards.length ? feedCard(cards[0], cards.length > 1) : `<div class="fcard" style="cursor:default"><span style="color:var(--green)">✓</span> You’re all caught up on updates.</div>`}
  <div class="tray">${seg('list', [['plan', `Plan · ${plan.length}`], ['tasks', `Tasks · ${tasks.length}`], ['lectures', `Lectures · ${lectures.length}`]], S.list)}${list}
    ${S.list === 'plan' && plan.length > 8 ? `<button class="row" data-tab="plan">All ${plan.length} in your plan<span class="grow"></span><span class="chev"></span></button>` : ''}</div>`;
}
function feedCard(c, stacked = false) {
  const co = course(c.course);
  return `<div class="fcard" data-card="${esc(c.id)}" role="button" tabindex="0"><div class="lab"><span>${c.sym}</span>${esc(c.label)}${c.at ? ` · ${esc(ago(c.at))}` : ''}</div>
    <div class="txt" dir="auto" style="display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden">${esc(c.text)}</div>${c.detail ? `<div class="det" dir="auto">${esc(c.detail)}</div>` : ''}
    <div class="foot"><span style="color:${color(c.course)}">${co ? esc(displayName(co)) : ''}</span><button class="pill" data-seen="${esc(c.id)}">Seen</button></div>${stacked ? '<div class="stack-shadow"></div>' : ''}</div>`;
}
function feedScreen() {
  const cards = feedCards();
  const earlier = [...S.updates.filter(u => u.seen && u.kind !== 'announcement'), ...S.insights.filter(i => i.kind !== 'brief')]
    .filter(x => !cards.some(c => c.id.endsWith(':' + x.id))).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 60);
  return `<button class="back" data-back>‹ Overview</button><div class="head"><h2>Updates & insights</h2>${cards.length ? '<button class="pill" data-allseen>Mark all seen</button>' : ''}</div>
  <div class="sec">New · ${cards.length}</div>${cards.length ? cards.map(c => feedCard(c)).join('') : '<div class="empty">Nothing new. You’re all caught up.</div>'}
  ${earlier.length ? `<div class="sec">Earlier</div><div class="group">${earlier.map(x => `<div class="row" style="align-items:flex-start"><span class="ico">${x.kind ? (UPDATE_META[x.kind]?.[0] || '•') : '✦'}</span><div class="grow"><div style="font-size:12px;color:var(--label2)">${esc(x.kind ? (UPDATE_META[x.kind]?.[1] || 'Update') : 'Claude')} · ${esc(ago(x.at))}</div><div dir="auto">${esc(x.text)}</div></div></div>`).join('')}</div>` : ''}`;
}
function progressScreen() {
  const all = catchUp(visibleItems());
  return `<button class="back" data-back>‹ Overview</button><div class="head"><h2>Progress</h2></div>
  <div class="group pad metrics">${ringWithText(all.fraction, 96, 11, 'var(--green)', all.percent, 20)}<div><b>Caught up</b><div style="color:var(--label2);font-size:15px">${all.behind} lectures to watch. Lectures held and deadlines passed, weighted by how much they matter. Going over the material counts half.</div></div></div>
  <div class="group">${visibleCourses().map(c => { const its = visibleItems().filter(i => i.c === c.id), s = catchUp(its), a = attendance(its); return `<button class="row" data-course="${esc(c.id)}">${ringWithText(s.fraction, 40, 5, color(c.id), s.percent, 9)}<span class="grow"><b style="color:${color(c.id)}">${esc(displayName(c))}</b><br><span style="color:var(--label2);font-size:13px">${s.behind ? `${s.behind} to watch` : 'caught up'}${a.attended ? ` · attended ${a.attended}/${a.held}` : ''}</span></span><span class="chev"></span></button>`; }).join('')}</div>`;
}
function courseScreen(id) {
  const c = course(id); if (!c) return '<div class="empty">Course not found.</div>';
  const its = S.items.filter(i => i.c === id && !i.hidden).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const s = catchUp(its), held = its.filter(i => isSession(i) && i.date <= today()), watched = held.filter(i => status(i) === 'done').length, att = attendance(its);
  const next = its.filter(i => !isSession(i) && isOpenish(i)).sort((a, b) => a.date.localeCompare(b.date))[0];
  const posts = S.updates.filter(u => u.kind === 'announcement' && u.course === id), unread = posts.filter(p => !p.seen).length;
  const metric = (v, l) => `<div class="metric" style="flex:1"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const tab = S.courseTab;
  let body;
  if (tab === 'weeks') {
    const cur = currentWeek();
    body = `<div class="cards">${weeks().map(w => { const ev = its.filter(i => i.date >= w.ws && i.date <= w.we); return `<button class="week-row" data-week="${w.ws}" aria-label="Week ${w.n}, ${ev.filter(isHandled).length} of ${ev.length} done"><span class="wk" style="color:${w.n === cur.n ? 'var(--accent)' : 'inherit'}">Week ${w.n}<small>${esc(dm(w.ws))}</small></span><span class="glyphs">${ev.length ? ev.slice(0, 8).map(glyph).join('') : '<span style="color:var(--label3);font-size:15px">Nothing this week</span>'}</span>${ev.length ? `<span style="color:var(--label2);font-size:15px">${ev.filter(isHandled).length}/${ev.length}</span>` : ''}<span class="chev"></span></button>`; }).join('')}</div>`;
  } else {
    const list = tab === 'lectures' ? its.filter(isSession) : tab === 'exams' ? its.filter(isExam) : its.filter(i => !isSession(i));
    body = cardsOr(list, tab === 'exams' ? 'No exams found.' : tab === 'lectures' ? 'No lectures yet.' : 'No tasks yet.', { showCourse: false });
  }
  const link = (href, ico, label) => `<a class="row" href="${esc(href)}" target="_blank" rel="noopener"><span class="ico">${ico}</span><span class="grow" style="color:var(--label)">${label}</span><span style="color:var(--label3)">↗</span></a>`;
  return `<button class="back" data-back>‹ Back</button><div class="head"><div><div class="sub" style="color:${color(id)}">${esc(short(c))}</div><h2>${esc(c.name)}</h2></div></div>
  <div class="group pad metrics">${ringWithText(s.fraction, 76, 9, color(id), s.percent, 15)}${metric(`${watched}/${held.length}`, 'watched')}${att.attended || (c.grading || []).some(g => /attend/i.test(g.label || '')) ? metric(`${att.attended}/${att.held}`, 'attended') : ''}${next ? metric(dm(next.date), 'next due') : metric(String(s.behind), 'to watch')}</div>
  <div class="group">${/^https?:/.test(c.moodle || '') ? link(c.moodle, ROW_ICONS.cap, 'Moodle') : ''}${/^https?:/.test(c.recordings || '') ? link(c.recordings, ROW_ICONS.play, 'Recordings') : ''}
    <button class="row" data-go="news:${esc(id)}"><span class="ico">${ROW_ICONS.megaphone}</span><span class="grow">Announcements</span>${unread ? `<span style="color:var(--accent)">${unread} new</span>` : ''}<span class="chev"></span></button>
    <button class="row" data-go="info:${esc(id)}"><span class="ico">${ROW_ICONS.doc}</span><span class="grow">Grading and course notes</span><span class="chev"></span></button>
    ${its.some(hasYourNotes) ? `<button class="row" data-go="notes:${esc(id)}"><span class="ico">${ROW_ICONS.note}</span><span class="grow">Your notes</span><span class="val">${its.filter(hasYourNotes).length}</span><span class="chev"></span></button>` : ''}</div>
  <div class="tray">${seg('courseTab', [['tasks', 'Tasks'], ['weeks', 'Weeks'], ['lectures', 'Lectures'], ['exams', 'Exams']], tab)}${body}</div>`;
}
// One event as a status symbol in the course color: circles for sessions, rounded squares for tasks.
function glyph(i) {
  const k = state(i).key, [g, cls] = inProgress(i) && ['todo', 'due', 'watch'].includes(k) ? ['◐', ''] : CIRCLE[k] || ['', ''];
  return `<span class="glyph ${isSession(i) ? '' : 'task'} ${cls}" style="color:${k === 'open' ? 'var(--label3)' : k === 'closed' || k === 'wont' ? 'var(--red)' : color(i.c)}" title="${esc(i.title)}: ${esc(state(i).text)}"><span>${g}</span></span>`;
}
// Every note you wrote, by course; tapping one opens its task or lecture. `id` limits it to one course.
function notesScreen(id) {
  const q = (S.notesQuery || '').trim().toLowerCase();
  const its = S.items.filter(i => !i.hidden && hasYourNotes(i) && (!id || i.c === id))
    .filter(i => !q || [i.title, yourNote(i), reflectionNote(i)].some(x => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const cs = (id ? [course(id)] : visibleCourses()).filter(c => c && its.some(i => i.c === c.id));
  return `<button class="back" data-back>‹ ${id ? esc(short(course(id))) : 'Overview'}</button><div class="head"><h2>${id ? `${esc(short(course(id)))} notes` : 'Your notes'}</h2></div>
  <input class="search" type="search" placeholder="Search your notes" value="${esc(S.notesQuery || '')}" data-notesq>
  ${its.length ? cs.map(c => `${id ? '' : `<div class="group-title" style="color:${color(c.id)}">${esc(displayName(c))}</div>`}<div class="group">${its.filter(i => i.c === c.id).map(i => `<button class="row note-row" data-open="${esc(i.id)}"><span class="grow"><span class="nt"><b dir="auto">${esc(i.title)}</b><span class="val">${esc(dm(i.date))}</span></span>${yourNote(i) ? `<span class="nb" dir="auto">${esc(yourNote(i))}</span>` : ''}${reflectionNote(i) ? `<span class="nb dim" dir="auto">💬 ${esc(reflectionNote(i))}</span>` : ''}</span></button>`).join('')}</div>`).join('')
    : `<div class="empty">${q ? 'No matches.' : 'No notes yet. Open a task or lecture and write where you left off. Your notes gather here.'}</div>`}`;
}
// One week of a course: each event spelled out with its symbol, then what the symbols mean.
function weekSheet(s) {
  const c = course(s.c), w = weeks().find(x => x.ws === s.ws); if (!c || !w) return '';
  const ev = S.items.filter(i => i.c === c.id && !i.hidden && i.date >= w.ws && i.date <= w.we).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const done = ev.filter(isHandled).length;
  const leg = (cls, g, text, col) => `<div class="row"><span class="glyph ${cls}" style="color:${col || color(c.id)}"><span>${g}</span></span><span class="grow">${text}</span></div>`;
  return `<div class="bar-top"><span></span><div style="text-align:center"><b>${esc(short(c))} · Week ${w.n}</b><div style="font-size:12px;color:var(--label2)">${esc(dm(w.ws))} – ${esc(dm(w.we))}</div></div><button class="pill" data-close>Done</button></div>
  ${ev.length ? `<div class="group-title">${done} of ${ev.length} done</div>` : ''}<div class="group">${ev.length ? ev.map(i => { const st = state(i), day = `${dow(i.date)} ${dm(i.date)}`;
    return `<button class="row" data-open="${esc(i.id)}">${glyph(i)}<span class="grow"><span dir="auto" style="display:block">${esc(i.title)}</span><span style="font-size:15px;color:var(--label2)">${i.title.startsWith(i.type) ? day : `${esc(i.type)} · ${day}`}</span></span><span style="font-size:15px;font-weight:500;color:${st.key === 'done' ? 'var(--green)' : st.key === 'reviewed' ? 'var(--mint)' : st.key === 'closed' || st.key === 'wont' ? 'var(--red)' : 'var(--label2)'}">${esc(st.text)}</span></button>`; }).join('') : '<div class="row val">Nothing this week.</div>'}</div>
  <div class="group"><button class="row" data-day="${w.ws}"><span class="ico">${ROW_ICONS.cal}</span><span class="grow" style="color:var(--accent)">Show in Schedule</span></button></div>
  <div class="group-title">Lectures and tutorials</div><div class="group">${leg('', '', 'To watch')}${leg('', '◐', 'In progress: you stopped partway')}${leg('filled', '✓', 'Watched or attended')}${leg('filled', '~', 'Skimmed')}${leg('locked', '', 'Upcoming', 'var(--label3)')}${leg('', '✕', 'Won’t watch', 'var(--red)')}</div>
  <div class="group-title">Tasks and exams</div><div class="group">${leg('task', '', 'To do')}${leg('task', '◐', 'In progress')}${leg('task filled', '✓', 'Done')}${leg('task filled', '~', 'Went over it')}${leg('task locked', '', 'Not open yet', 'var(--label3)')}${leg('task filled', '!', 'Missed: the deadline passed', 'var(--red)')}${leg('task', '✕', 'Won’t do', 'var(--red)')}</div>
  <div class="foot">Symbols are in the course color. Gray means it hasn’t started yet, red means it was missed or skipped.</div>`;
}
function newsScreen(id) {
  const c = course(id), posts = S.updates.filter(u => u.kind === 'announcement' && u.course === id).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return `<button class="back" data-back>‹ ${esc(short(c))}</button><div class="head"><div><div class="sub">${esc(c?.name || '')}</div><h2>Announcements</h2></div></div>
  ${posts.length ? posts.map(u => { const subject = u.text.startsWith(short(c) + ': ') ? u.text.slice(short(c).length + 2) : u.text; const sum = S.insights.find(i => (i.about || []).includes(u.id));
    return `<div class="group pad"><div style="font-size:12px;font-weight:600;color:var(--label2)">${u.seen ? '' : '<span style="color:var(--accent)">●</span> '}${esc(ago(u.at))}</div><div dir="auto" style="font-weight:600;margin:6px 0">${esc(subject)}</div><div class="post" dir="auto">${esc(u.detail || '')}</div>${sum ? `<div class="summary">✦ ${esc(sum.text)}</div>` : ''}${u.link ? `<a href="${esc(u.link)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;font-weight:600;font-size:15px">Open in Moodle ↗</a>` : ''}</div>`; }).join('') : '<div class="empty">No announcements yet.</div>'}`;
}
function infoScreen(id) {
  const c = course(id) || {};
  return `<button class="back" data-back>‹ ${esc(short(c))}</button><div class="head"><h2>Notes and grading</h2></div>
  <div class="group-title">Grading</div><div class="group">${(c.grading || []).length ? c.grading.map(g => `<div class="row"><span class="grow">${esc(g.label || g.kind)}</span><span class="val">${fmt(g.weight)}%</span></div>`).join('') : '<div class="row val">No grade breakdown yet.</div>'}</div>
  ${(profile(c).rules || []).length ? `<div class="group-title">What Claude knows</div><div class="group">${profile(c).rules.map(r => `<div class="row">${esc(r)}</div>`).join('')}</div>` : ''}
  <div class="group-title">Notes</div><div class="group pad post" dir="auto">${esc(c.notes || 'No notes for this course.')}</div>`;
}
function scheduleScreen() {
  const w = weeks(), first = parse(w[0].ws), last = addDays(parse(w[w.length - 1].ws), 6);
  const d = S.day || (today() < iso(first) ? iso(first) : today() > iso(last) ? iso(last) : today());
  const days = []; for (let x = first; x <= last; x = addDays(x, 1)) days.push(iso(x));
  const ev = day => { const out = []; for (const it of visibleItems()) { if (it.date === day) out.push({ it, kind: isSession(it) ? 'session' : 'due' }); if (it.opens === day && state(it).key === 'open') out.push({ it, kind: 'opens' }); } return out; };
  const e = ev(d), tasks = e.filter(x => x.kind !== 'session'), lect = e.filter(x => x.kind === 'session');
  const byTime = (a, b) => (a.it.time || '99').localeCompare(b.it.time || '99');
  const wk = w.find(x => d >= x.ws && d <= x.we);
  return `<div class="head"><div><div class="sub">${d === today() ? 'Today · ' : ''}${wk ? `Week ${wk.n}` : ''}</div><h1 style="font-size:28px">${esc(dayLabel(d))}</h1></div>${d !== today() ? '<button class="pill" data-day="today">Today</button>' : ''}</div>
  <div class="day-strip" id="strip">${days.map(x => { const es = ev(x), due = es.some(y => y.kind === 'due'); return `<button class="day ${x === d ? 'on' : ''} ${x === today() ? 'today' : ''}" data-day="${x}" id="d-${x}">${DOW[parse(x).getDay()]}<b>${parse(x).getDate()}</b><span class="dot" style="background:${due ? 'var(--label2)' : es.length ? 'var(--label3)' : 'transparent'}"></span></button>`; }).join('')}</div>
  ${tasks.length ? `<div class="sec">Tasks</div>${cardsOr(tasks.sort(byTime).map(x => x.it), '', { trailing: 'time' })}` : ''}
  ${lect.length ? `<div class="sec">Lectures</div>${cardsOr(lect.sort(byTime).map(x => x.it), '', { trailing: 'time' })}` : ''}
  ${!e.length ? '<div class="empty" style="text-align:center;padding:40px 0">Nothing on this day.</div>' : ''}`;
}
function planScreen() {
  const plan = planItems(), open = plan.filter(i => !isHandled(i)).length;
  return `<div class="head"><div><div class="sub">${plan.length ? `${open} to go${plan.length - open ? ` · ${plan.length - open} done` : ''}` : 'Your order of work'}</div><h1>Plan</h1></div>${plan.length > open ? '<button class="pill" data-cleardone>Clear done</button>' : ''}</div>
  ${plan.length ? `<div class="cards">${plan.map((it, n) => `<div style="display:flex;gap:8px;align-items:center"><span style="width:20px;text-align:center;color:var(--label2);font-weight:600">${n + 1}</span><div style="flex:1;min-width:0">${card(it, { showPlanTag: false })}</div>
    <div style="display:grid;gap:2px"><button class="round" style="width:32px;height:32px;font-size:14px" data-move="${esc(it.id)}" data-dir="-1" aria-label="Move up" ${n === 0 ? 'disabled' : ''}>↑</button><button class="round" style="width:32px;height:32px;font-size:14px" data-move="${esc(it.id)}" data-dir="1" aria-label="Move down" ${n === plan.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('')}</div>`
    : '<div class="group pad" style="text-align:center"><b>No plan yet</b><p style="color:var(--label2)">Put the tasks and lectures you want to get through in order. Open any card and tap the plan button.</p></div>'}`;
}
function settingsScreen() {
  const fresh = (label, stamp) => { const d = stamp ? new Date(stamp) : null, h = d ? (Date.now() - d) / 36e5 : 1e9; const c = h <= 7 ? 'var(--green)' : h <= 72 ? 'var(--orange)' : 'var(--red)';
    return `<div class="row"><span class="dot" style="width:10px;height:10px;background:${c}"></span><span class="grow">${label}</span><span class="val">${d ? esc(ago(d)) : 'never'}</span></div>`; };
  const sel = (key, opts, def) => `<select data-pref="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(S.prefs[key] ?? def) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="head"><h1>Settings</h1></div>
  <div class="group-title">Account</div><div class="group"><div class="row"><span class="grow">Signed in as</span><span class="val">${esc(S.user.email)}</span></div><div class="row"><span class="grow" style="color:var(--label2);font-size:15px">Same data as the iPhone app. Changes here show up there after its next sync, and the other way around.</span></div></div>
  <div class="group-title">Data freshness</div><div class="group">${fresh('Calendar sync', S.prefs.lastCalendarSync)}${fresh('Moodle sync', S.prefs.lastMoodleSync)}</div>
  <div class="group-foot">The cloud sync runs every hour, and Claude every evening. Connecting Moodle and the Update now buttons are in the iPhone app.</div>
  <div class="group-title">Display</div><div class="group"><div class="row"><span class="grow">Appearance</span>${sel('appearance', [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], 'system')}</div>
    <div class="row"><span class="grow">Dates</span>${sel('dateStyle', ['d/MMM', 'd MMM', 'MMM d', 'd/M', 'd.M'].map(s => [s, s.replace('d', '21').replace('MMM', 'Oct').replace('M', '10')]), 'd/MMM')}</div>
    <div class="row"><span class="grow">Day of the week</span>${sel('showWeekday', [['true', 'On'], ['false', 'Off']], 'true')}</div>
    <div class="row"><span class="grow">Ask how it went</span>${sel('askReflection', [['true', 'On'], ['false', 'Off']], 'true')}</div></div>
  <div class="group"><button class="row" data-go="feed"><span class="grow">Updates and insights</span><span class="chev"></span></button><a class="row" href="legacy.html"><span class="grow" style="color:var(--label)">Old web version</span><span class="chev"></span></a></div>
  <div class="group"><button class="row" data-signout style="color:var(--red)">Sign out</button></div>`;
}

// ---------- Sheets ----------
function openSheet(s) { S.sheet = s; renderSheet(); }
function closeSheet() { S.sheet = null; $('#layer').innerHTML = ''; }
function renderSheet() {
  const s = S.sheet; if (!s) { $('#layer').innerHTML = ''; return; }
  let html = '';
  if (s.kind === 'item') html = itemSheet(s.id);
  else if (s.kind === 'reflect') html = reflectSheet(s);
  else if (s.kind === 'card') html = cardSheet(s.id);
  else if (s.kind === 'questions') html = questionSheet();
  else if (s.kind === 'week') html = weekSheet(s);
  $('#layer').innerHTML = `<div class="scrim" data-scrim><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
}
function itemSheet(id) {
  const it = item(id); if (!it) return '<div class="empty">Not found.</div>';
  const c = course(it.c), st = state(it), handled = isHandled(it), sess = isSession(it);
  let headline = st.text;
  if (!handled && st.key !== 'closed' && st.key !== 'open' && parse(it.date)) {
    if (sess) { const n = daysBetween(parse(it.date), new Date()); headline = n <= 0 ? 'Today' : n === 1 ? 'Yesterday, not watched yet' : `${n} days behind · held ${dayLabel(it.date)}`; }
    else { const n = daysBetween(new Date(), parse(it.date)); headline = `${inProgress(it) ? 'In progress · due ' : 'Due '}${n <= 0 ? 'today' : n === 1 ? 'tomorrow' : dayLabel(it.date)}${it.time ? `, ${it.time}` : ''}`; }
  }
  const link = /^https?:/.test(it.link || '') ? it.link : sess && /^https?:/.test(c?.recordings || '') ? c.recordings : null;
  const mins = Math.round(seconds(it.stopAt) / 60), dur = it.duration || 90;
  const more = [!handled && !inProgress(it) ? ['progress', 'In progress'] : null, sess && it.type !== 'Online unit' ? ['attended', 'Attended'] : null, ['reviewed', sess ? 'Skimmed' : 'Went over it'], ['skip', sess ? 'Won’t watch' : 'Won’t do']].filter(Boolean);
  return `<div class="bar-top"><button class="pill" data-close>Close</button></div>
  <div class="group pad"><div style="font-size:15px"><b style="color:${color(it.c)}">${esc(short(c))}</b> <span style="color:var(--label2)">${esc(it.type)}</span></div>
    <div dir="auto" style="font-size:24px;font-weight:700;margin:6px 0">${esc(it.title)}</div>
    <div style="font-size:15px;font-weight:500;color:${handled || st.key === 'closed' ? (st.key === 'done' ? 'var(--green)' : st.key === 'reviewed' ? 'var(--mint)' : 'var(--red)') : 'var(--label)'}">${!handled && isExam(it) ? '<span class="tag strong">Exam</span> ' : ''}${esc(headline)}</div>
    <div class="actions">${handled ? `<button class="pill wide" data-status="${esc(id)}" data-val="todo">↺ ${sess ? 'Mark to watch' : 'Mark to do'}</button>` : `<button class="pill wide primary" data-status="${esc(id)}" data-val="done">✓ ${sess ? 'Watched' : 'Done'}</button>`}
      <button class="pill" data-plan="${esc(id)}" aria-label="${inPlan(id) ? 'Remove from plan' : 'Add to plan'}">${inPlan(id) ? '≡ In plan' : '≡ Plan'}</button></div>
    <details style="margin-top:10px"><summary style="color:var(--accent);font-size:15px;cursor:pointer">More statuses</summary><div class="menu">${more.map(([v, l]) => `<button class="pill" style="text-align:left" data-status="${esc(id)}" data-val="${v}">${esc(l)}</button>`).join('')}</div></details></div>
  ${sess && !handled ? `<div class="group pad"><div style="display:flex;justify-content:space-between"><span>Watched up to</span><span style="color:var(--label2)" id="mins">${mins} of ${dur} min</span></div><input type="range" min="0" max="${dur}" value="${mins}" data-stop="${esc(id)}"></div>` : ''}
  <div class="group-title">Notes</div><div class="group pad"><textarea rows="3" dir="auto" placeholder="Where you left off, what to do next…" data-note="${esc(id)}">${esc(it.note || '')}</textarea></div>
  <div class="group">${link ? `<a class="row" href="${esc(link)}" target="_blank" rel="noopener"><span class="grow">${sess ? 'Watch recording' : 'Open in Moodle'}</span><span style="color:var(--label3)">↗</span></a>` : ''}${c ? `<button class="row" data-course="${esc(c.id)}"><span class="grow">${esc(c.name)}</span><span class="chev"></span></button>` : ''}</div>
  <div class="group-title">Details</div><div class="group"><div class="row"><span class="grow">${sess ? 'Held' : 'Due'}</span><span class="val">${esc(dayLabel(it.date))}${it.time ? ` · ${esc(it.time)}` : ''}</span></div>${it.opens ? `<div class="row"><span class="grow">Opens</span><span class="val">${esc(dayLabel(it.opens))}${it.opensTime ? ` · ${esc(it.opensTime)}` : ''}</span></div>` : ''}${it.weight > 0 ? `<div class="row"><span class="grow">Weight</span><span class="val">${fmt(it.weight)}% of final grade</span></div>` : ''}<div class="row"><span class="grow">Importance</span><span class="val">${['Low', 'Medium', 'High'][importance(it) - 1]}</span></div></div>`;
}
function reflectSheet(s) {
  const it = item(s.id); if (!it) return '';
  s.a = s.a || {};
  const chips = (key, labels, values) => `<div class="chips">${labels.map((l, i) => `<button class="${s.a[key] === values[i] ? 'on' : ''}" data-chip="${key}" data-val="${values[i]}">${esc(l)}</button>`).join('')}</div>`;
  return `<div class="bar-top"><button class="pill" data-reflect-skip>Skip</button><b>How did it go?</b><button class="pill primary" data-reflect-save>Save</button></div>
  <div style="text-align:center;color:var(--label2);font-size:15px;margin-bottom:10px" dir="auto">${esc(it.title)}</div>
  <div class="group-title">How hard was it?</div><div class="group pad">${chips('difficulty', ['Easy', 'OK', 'Hard'], [1, 2, 3])}</div>
  ${isSession(it) ? `<div class="group-title">Did you follow it?</div><div class="group pad">${chips('followed', ['Yes', 'Partly', 'Lost me'], [1, 2, 3])}</div>`
    : `<div class="group-title">How long did it take?</div><div class="group pad">${chips('minutes', ['< 30 min', '~1 h', '~2 h', '3 h+'], [20, 60, 120, 200])}</div>`}
  <div class="group pad"><textarea rows="2" dir="auto" placeholder="Anything to remember for next time? (optional)" data-reflect-note>${esc(s.a.note || '')}</textarea></div>
  <div class="group-foot" style="margin-top:-6px">Claude uses this to plan your weeks, like starting earlier on what takes you long.</div>`;
}
function cardSheet(id) {
  const c = feedCards().find(x => x.id === id) || S.lastCard; if (!c) return '';
  S.lastCard = c; const co = course(c.course);
  return `<div class="bar-top"><button class="pill" data-close>Close</button><button class="pill primary" data-seen="${esc(c.id)}">Seen</button></div>
  <div class="group pad"><div class="lab" style="font-size:15px;font-weight:600;color:var(--label2)">${c.sym} ${esc(c.label)}${c.at ? ` · ${esc(ago(c.at))}` : ''}</div>
  <div dir="auto" style="font-size:20px;font-weight:600;margin:10px 0">${esc(c.text)}</div>${c.detail ? `<div class="post" dir="auto">${esc(c.detail)}</div>` : ''}
  ${co ? `<div style="color:${color(c.course)};font-weight:600;font-size:15px;margin-top:10px">${esc(co.name)}</div>` : ''}
  <div class="actions">${c.link ? `<a class="pill wide primary" href="${esc(c.link)}" target="_blank" rel="noopener">Moodle ↗</a>` : ''}${c.about?.length && co ? `<button class="pill wide" data-go="news:${esc(co.id)}">Announcement</button>` : ''}${c.item && item(c.item) ? `<button class="pill wide" data-openitem="${esc(c.item)}">Task</button>` : co ? `<button class="pill wide" data-course="${esc(co.id)}">${esc(short(co))}</button>` : ''}</div></div>`;
}
function questionSheet() {
  const q = S.questions.filter(x => (x.status || 'open') === 'open').sort((a, b) => (a.deferred || 0) - (b.deferred || 0))[0];
  if (!q) return '<div class="bar-top"><button class="pill" data-close>Close</button></div><div class="group pad" style="text-align:center">All answered. Thanks, Claude will use your answers on its next run.</div>';
  const body = q.kind === 'rank' ? `<div class="empty">This one asks you to put things in order. Answer it in the iPhone app.</div>`
    : `<div class="menu">${(q.options || []).map(o => `<button class="pill" style="text-align:left;padding:12px 14px" data-answer="${esc(q.id)}" data-opt="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>`;
  return `<div class="bar-top"><button class="pill" data-close>Close</button><button class="pill" data-qskip="${esc(q.id)}">Not now</button></div>
  <div class="group pad"><div style="color:var(--c-purple);font-weight:600;font-size:15px">✦ Claude asks${q.course && course(q.course) ? ` · ${esc(short(course(q.course)))}` : ''}</div><div dir="auto" style="font-size:20px;font-weight:600;margin:8px 0">${esc(q.text)}</div>${q.detail ? `<div style="color:var(--label2);font-size:15px" dir="auto">${esc(q.detail)}</div>` : ''}${body}</div>`;
}
function answerQuestion(qid, optId) {
  const q = S.questions.find(x => x.id === qid), o = (q?.options || []).find(x => x.id === optId); if (!o) return;
  optimistic('question', qid, d => { d.status = 'answered'; d.answer = { choice: o.id, label: o.label }; d.answeredAt = new Date().toISOString(); return d; });
  // Only a few safe fields can change right away, the same as in the iPhone app.
  for (const e of o.effects || []) {
    if (e.col === 'item' && e.set) patch('item', e.id, d => { for (const [k, v] of Object.entries(e.set)) if (['status', 'myImportance', 'hidden'].includes(k)) { if (v == null) delete d[k]; else d[k] = v; } return d; });
    if (e.col === 'course' && e.profile) patch('course', e.id, d => { d.profile = { ...(d.profile || {}) }; for (const [k, v] of Object.entries(e.profile)) { if (v == null) delete d.profile[k]; else d.profile[k] = v; } return d; });
  }
  toast('Thanks. Claude will use this on its next run.');
}

// ---------- Shell ----------
function applyTheme() { const a = S.prefs.appearance; if (a === 'light' || a === 'dark') document.documentElement.dataset.theme = a; else delete document.documentElement.dataset.theme; }
let toastTimer;
function toast(msg, undo) {
  clearTimeout(toastTimer); document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
  if (undo) t.querySelector('button').onclick = () => { t.remove(); undo(); };
  document.body.appendChild(t); toastTimer = setTimeout(() => t.remove(), undo ? 5000 : 2400);
}
function render() {
  if (!S.user) return authScreen();
  if (!S.loaded) { $('#app').innerHTML = '<div class="empty" style="text-align:center;padding-top:30vh">Loading your semester…</div>'; return; }
  const r = S.route[S.route.length - 1];
  let html;
  if (r === 'feed') html = feedScreen();
  else if (r === 'progress') html = progressScreen();
  else if (r?.startsWith('course:')) html = courseScreen(r.slice(7));
  else if (r?.startsWith('news:')) html = newsScreen(r.slice(5));
  else if (r?.startsWith('info:')) html = infoScreen(r.slice(5));
  else if (r === 'notes' || r?.startsWith('notes:')) html = notesScreen(r.slice(6));
  else html = { overview, schedule: scheduleScreen, plan: planScreen, settings: settingsScreen }[S.tab]();
  $('#app').innerHTML = html;
  const tabs = $('#tabs'); tabs.classList.remove('hidden');
  tabs.innerHTML = [['overview', 'Overview'], ['schedule', 'Schedule'], ['plan', 'Plan'], ['settings', 'Settings']].map(([k, l]) => `<button class="${S.tab === k && !S.route.length ? 'on' : S.tab === k ? 'on' : ''}" data-tab="${k}" aria-label="${l}">${ICONS[k]}<span>${l}</span></button>`).join('');
  if (S.tab === 'schedule' && !S.route.length) document.getElementById('d-' + (S.day || today()))?.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (S.sheet) renderSheet();
}
function go(route) { S.route.push(route); window.scrollTo(0, 0); render(); }
function back() {
  const r = S.route.pop();
  if (r?.startsWith('news:')) { const unseen = S.updates.filter(u => u.kind === 'announcement' && u.course === r.slice(5) && !u.seen).map(u => u.id); if (unseen.length) markSeen(unseen); }
  render();
}
function authScreen(mode = 'in', err = '') {
  $('#tabs').classList.add('hidden');
  $('#app').innerHTML = `<div class="auth"><img src="icons/icon-192.png" alt="" width="72" height="72" style="border-radius:16px"><h1 style="margin:12px 0 4px">Semester Catch-Up</h1><p style="color:var(--label2);margin:0 0 20px">Sign in with the same account as the iPhone app.</p>
  <form id="auth"><div class="group"><div class="row"><input type="email" name="email" placeholder="Email" autocomplete="email" required></div><div class="row"><input type="password" name="password" placeholder="Password" autocomplete="current-password" required></div></div>
  ${err ? `<div class="err">${esc(err)}</div>` : ''}<button class="pill primary wide" style="width:100%">Sign in</button></form>
  <button style="margin-top:14px;color:var(--accent);font-size:15px" id="forgot">Forgot password?</button></div>`;
  $('#auth').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') }); if (error) authScreen('in', error.message); };
  $('#forgot').onclick = async () => { const email = $('#auth').email.value; if (!email) return authScreen('in', 'Type your email first.');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] }); authScreen('in', error ? error.message : 'Check your email for a reset link.'); };
}

// ---------- Events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-open], [data-card], [data-scrim], a'); if (!t) return;
  const d = t.dataset;
  if (d.scrim !== undefined && e.target === t) return closeSheet();
  if (d.toggle) { e.stopPropagation(); const it = item(d.toggle); return setStatus(d.toggle, isHandled(it) ? 'todo' : 'done'); }
  if (d.seen) { e.stopPropagation(); const c = feedCards().find(x => x.id === d.seen) || S.lastCard; if (c) seenCard(c); if (S.sheet?.kind === 'card') closeSheet(); return; }
  if (d.open) { if (t.tagName === 'A') return; return openSheet({ kind: 'item', id: d.open }); }
  if (d.openitem) return openSheet({ kind: 'item', id: d.openitem });
  if (d.card) return openSheet({ kind: 'card', id: d.card });
  if (d.week) return openSheet({ kind: 'week', c: S.route[S.route.length - 1].slice(7), ws: d.week });
  if (d.tab) { S.tab = d.tab; S.route = []; closeSheet(); window.scrollTo(0, 0); return render(); }
  if (d.go) { closeSheet(); return go(d.go); }
  if (d.back !== undefined) return back();
  if (d.course) { closeSheet(); S.tab = 'overview'; S.route = [`course:${d.course}`]; S.courseTab = 'tasks'; window.scrollTo(0, 0); return render(); }
  if (d.seg) { S[d.seg] = d.val; return render(); }
  if (d.day) { closeSheet(); S.day = d.day === 'today' ? null : d.day; S.tab = 'schedule'; S.route = []; return render(); }
  if (d.close !== undefined) return closeSheet();
  if (d.status) { setStatus(d.status, d.val); if (S.sheet?.kind === 'item' && !(['done', 'attended', 'reviewed'].includes(d.val))) renderSheet(); else if (S.sheet?.kind === 'item') closeSheet(); return; }
  if (d.plan) { togglePlan(d.plan); return; }
  if (d.move) { const ids = planIDs(), i = ids.indexOf(d.move), j = i + Number(d.dir); if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; return setPref('plan', ids); }
  if (d.cleardone !== undefined) return setPref('plan', planIDs().filter(id => !isHandled(item(id))));
  if (d.allseen !== undefined) { feedCards().forEach(seenCard); return; }
  if (d.sheet === 'questions') return openSheet({ kind: 'questions' });
  if (d.answer) { answerQuestion(d.answer, d.opt); return renderSheet(); }
  if (d.qskip) { optimistic('question', d.qskip, q => { q.deferred = (q.deferred || 0) + 1; return q; }); return renderSheet(); }
  if (d.chip) { const s = S.sheet; s.a = s.a || {}; const v = Number(d.val); s.a[d.chip] = s.a[d.chip] === v ? undefined : v; return renderSheet(); }
  if (d.reflectSkip !== undefined) { const id = S.sheet.id; closeSheet(); return patch('item', id, x => { x.reflection = { skipped: true, at: today() }; return x; }); }
  if (d.reflectSave !== undefined) { const s = S.sheet, r = { at: today() }; for (const k of ['difficulty', 'minutes', 'followed']) if (s.a?.[k] != null) r[k] = s.a[k]; if (s.a?.note?.trim()) r.note = s.a.note.trim(); closeSheet(); return patch('item', s.id, x => { x.reflection = r; return x; }); }
  if (d.signout !== undefined) { sb.auth.signOut(); return; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) closeSheet(); if (e.key === 'Enter' && e.target.matches('[data-open],[data-card]')) e.target.click(); });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.stop) { const v = Number(t.value); $('#mins').textContent = `${v} of ${item(t.dataset.stop)?.duration || 90} min`; }
  if (t.dataset.reflectNote !== undefined) { S.sheet.a = S.sheet.a || {}; S.sheet.a.note = t.value; }
  if (t.dataset.notesq !== undefined) { S.notesQuery = t.value; render(); const q = $('[data-notesq]'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.stop) { const id = t.dataset.stop, v = Number(t.value), it = item(id);
    patch('item', id, x => { if (v > 0) x.stopAt = clock(v * 60); else delete x.stopAt; if (v > 0 && (x.status || 'todo') === 'todo') x.status = 'progress'; if (v === 0 && x.status === 'progress') x.status = 'todo'; return x; });
    if (it && v >= (it.duration || 90)) setStatus(id, 'done'); }
  if (t.dataset.note) { const id = t.dataset.note, v = t.value; patch('item', id, x => { x.note = v; x.locked = [...new Set([...(x.locked || []), 'note'])].sort(); return x; }); }
  if (t.dataset.pref) { const k = t.dataset.pref, v = t.value; setPref(k, v === 'true' ? true : v === 'false' ? false : v === 'system' ? null : v); applyTheme(); }
});

// Keep in step with the iPhone app and the syncs: reload when the page comes back, and every 2 minutes.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.user && !S.sheet) load(); });
setInterval(() => { if (document.visibilityState === 'visible' && S.user && !S.sheet) load(); }, 120000);

if (DEMO) { S.user = { id: 'demo', email: 'demo' }; load(); } else sb.auth.onAuthStateChange((_e, session) => {
  const was = S.user?.id; S.user = session?.user || null;
  if (!S.user) { S.loaded = false; return render(); }
  if (was !== S.user.id) { S.loaded = false; render(); load(); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
