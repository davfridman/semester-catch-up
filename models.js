// The shared models: what every screen reads, decided from the app's state (S) and the pure rules in rules.js.
// Nothing here changes data or draws anything. Feature files read these instead of calling each other.
'use strict';

// ---------- Rules and dates (local time, like the app) ----------
const COLORS = ['blue', 'purple', 'pink', 'teal', 'indigo', 'orange', 'cyan', 'brown'];
// The rules themselves are in rules.js (shared with check_web.mjs); here they're bound to this page's state.
const { pad, iso, parse, addDays, daysBetween, DOW, dow, isSession, status, isHandled, inProgress, isGate, profile, importance, isSlot } = Rules;
const today = (now = new Date()) => iso(now);
const dm = s => Rules.dm(s, S.prefs.dateStyle);
const dayLabel = s => (S.prefs.showWeekday === false || !parse(s) ? dm(s) : `${dow(s)} ${dm(s)}`);

// ---------- Courses and items ----------
const course = id => S.courses.find(c => c.id === id);
const item = id => S.items.find(i => i.id === id);
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
const state = (it, now = new Date()) => Rules.state(it, now, S.prefs.dateStyle);
const isOpenish = (it, now = new Date()) => Rules.isOpenish(it, now);
const rankedTasks = (items, now = new Date()) => Rules.rankedTasks(items, S.courses, now);
const catchUp = (items, now = new Date()) => Rules.catchUp(items, now);
const weeks = () => Rules.weeks(S.prefs);
const currentWeek = (now = new Date()) => Rules.currentWeek(weeks(), now);

// ---------- Reading the plan (its actions are in features/plan.js) ----------
// The plan (format in rules.js): prefs.plan is the top level, prefs.planSlots each slot's name, cards and fold.
const planModel = () => Rules.planModel(S.prefs, id => !!item(id));
const slotNames = () => Object.fromEntries(Object.entries(planModel().slots).map(([k, v]) => [k, v.name]));
const slotItems = id => (planModel().slots[id]?.items || []).map(item);
const slotOf = id => Object.entries(planModel().slots).find(([, v]) => v.items.includes(id))?.[0];
const planIDs = () => Rules.planIDs(planModel());
const planItems = () => planIDs().map(item).filter(i => i && !i.hidden);
const inPlan = id => planIDs().includes(id);

// ---------- Attendance and your notes ----------
const attendance = its => { const held = its.filter(i => isSession(i) && i.type !== 'Online unit' && i.date <= today()); return { attended: held.filter(i => status(i) === 'attended').length, held: held.length }; };
// What you wrote yourself: a note you typed (the sync's own notes don't count) and what you said about how it went.
const yourNote = it => (it.locked || []).includes('note') ? (it.note || '').trim() : '';
const reflectionNote = it => it.reflection?.note || '';
const hasYourNotes = it => !!(yourNote(it) || reflectionNote(it));

// ---------- The feed: updates and Claude's insights as cards (FeedRules in the iPhone app) ----------
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
