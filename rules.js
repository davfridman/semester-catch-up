// Semester Catch-Up's rules: task status, importance, ranking, catch-up, semester weeks, date styles and the plan's
// stored format. The same rules as the iPhone app (Core/Rules), checked against contract/fixtures/rules.json by
// contract/check_web.mjs. Pure functions only: no page, no data loading, and the clock only as a default `now`.
// index.html loads this before the page's other scripts; models.js binds these to its state (S.prefs, S.courses, the current time).
'use strict';

const Rules = (() => {
  const SESSION_TYPES = new Set(['Lecture', 'Tutorial', 'Online unit']);
  const HANDLED = ['done', 'skip', 'attended', 'reviewed'];

  // ---------- Dates (local time, like the app) ----------
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => (s && s.length === 10 ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const daysBetween = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  /// "4/Nov" in the chosen style: "d/MMM" (the default, also for unknown styles), "d MMM", "MMM d", "d/M" or "d.M".
  function dm(s, style) {
    const d = typeof s === 'string' ? parse(s) : s; if (!d) return '';
    const day = d.getDate(), m = d.getMonth();
    switch (style) {
      case 'd MMM': return `${day} ${MONTHS[m]}`;
      case 'MMM d': return `${MONTHS[m]} ${day}`;
      case 'd/M': return `${day}/${m + 1}`;
      case 'd.M': return `${day}.${m + 1}`;
      default: return `${day}/${MONTHS[m]}`;
    }
  }
  const dow = s => { const d = parse(s); return d ? DOW[d.getDay()] : ''; };

  // ---------- Items ----------
  const isSession = it => SESSION_TYPES.has(it.type);
  const status = it => it.status || 'todo';
  const isHandled = it => HANDLED.includes(status(it));
  const inProgress = it => status(it) === 'progress';
  const isGate = it => /required|gate/i.test(it.note || '');
  const profile = c => (c && c.profile) || {};

  /// What an item's circle and caption say at `now`: {key, text}. `style` is the date style for "Opens 4/Nov".
  function state(it, now = new Date(), style) {
    const s = baseState(it, now, style);
    // In progress keeps its deadline color but says so.
    if (!inProgress(it) || s.key === 'closed' || s.key === 'open') return s;
    return { key: s.key, text: isSession(it) ? 'In progress' : `In progress · ${s.text.toLowerCase()}` };
  }
  function baseState(it, now, style) {
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
    if (it.opens && it.opens > t) return { key: 'open', text: `Opens ${dm(it.opens, style)}` };
    const n = parse(it.date) ? daysBetween(now, parse(it.date)) : 0;
    const passed = n < 0 || (n === 0 && it.time && it.time < hhmm(now));
    if (passed && it.optional) return { key: 'open', text: 'Not taken' };   // an exam's Moed B, for example
    if (passed) return { key: 'closed', text: 'Missed' };
    if (n <= 3) return { key: 'due', text: n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : `Due ${dow(it.date)}` };
    return { key: 'todo', text: `Due ${dm(it.date, style)}` };
  }
  const isOpenish = (it, now = new Date()) => ['todo', 'due', 'watch'].includes(state(it, now).key);

  /// 3 = exams, required gates and anything worth 10%+; 2 = worth 3%+ or a project; 1 = the rest.
  /// The user's More/Less nudge (myImportance) moves it one step.
  function importance(it) {
    const w = it.weight || 0;
    const base = it.type === 'Exam' || isGate(it) || w >= 10 ? 3 : w >= 3 || it.type === 'Project' ? 2 : 1;
    return Math.min(3, Math.max(1, base + (it.myImportance || 0)));
  }
  /// How soon it's due times how much it counts. Higher = do it first.
  function priorityScore(it, now = new Date()) {
    const d = parse(it.date) ? daysBetween(now, parse(it.date)) : 99;
    const u = d <= 1 ? 4 : d <= 3 ? 3 : d <= 7 ? 2 : d <= 14 ? 1 : 0.5;
    return u * (1 + importance(it) * 1.5) + (it.weight || 0) / 10;
  }
  /// Each course's factor from its rank and goal, so a top course's 5% exercise can outrank a "just pass" course's 10% quiz.
  function courseFactors(courses) {
    const goal = { pass: 0.8, good: 1, top: 1.25 }, f = {};
    const ranked = courses.filter(c => profile(c).rank != null).sort((a, b) => profile(a).rank - profile(b).rank);
    for (const c of courses) f[c.id] = goal[profile(c).goal] ?? 1;
    ranked.forEach((c, i) => { if (ranked.length > 1) f[c.id] *= 1.15 - 0.3 * i / (ranked.length - 1); });
    return f;
  }
  const rankScore = (it, factors, now = new Date()) => priorityScore(it, now) * (factors[it.c] ?? 1);
  /// Open tasks, most important and most urgent first.
  function rankedTasks(items, courses, now = new Date()) {
    const f = courseFactors(courses);
    return items.filter(i => !isSession(i) && isOpenish(i, now)).sort((a, b) => rankScore(b, f, now) - rankScore(a, f, now));
  }

  /// How much of what has already happened (lectures held, tasks whose deadline passed) is done or deliberately
  /// skipped, weighted by importance. Optional items (an exam's Moed B) only count once you've done them.
  function catchUp(items, now = new Date()) {
    const t = iso(now); let handled = 0, total = 0, behind = 0;
    for (const it of items) {
      if (!it.date || (it.optional && !isHandled(it))) continue;
      const happened = isSession(it) ? it.date <= t : it.date < t || state(it, now).key === 'closed';
      if (!happened) continue;
      const w = importance(it); total += w;
      // Going over the material counts as half done.
      if (isHandled(it)) handled += status(it) === 'reviewed' ? w / 2 : w; else if (isSession(it)) behind++;
    }
    const fraction = total > 0 ? handled / total : null;
    return { handled, total, fraction, behind, percent: fraction == null ? '—' : `${Math.round(fraction * 100)}%` };
  }

  /// The semester's weeks from prefs.semStart (default 11 Oct 2026) to prefs.semEnd (15 weeks when unset).
  function weeks(prefs = {}) {
    const start = parse(prefs.semStart) || parse('2026-10-11');
    let count = 15;
    if (parse(prefs.semEnd)) count = Math.max(1, Math.ceil((daysBetween(start, parse(prefs.semEnd)) + 1) / 7));
    return Array.from({ length: count }, (_, i) => { const s = addDays(start, i * 7); return { n: i + 1, ws: iso(s), we: iso(addDays(s, 6)) }; });
  }
  const currentWeek = (w, now = new Date()) => { const t = iso(now); return w.find(x => t >= x.ws && t <= x.we) || (t < w[0].ws ? w[0] : w[w.length - 1]); };

  // The plan: prefs.plan is the top level in order (item ids and "slot:<id>"); prefs.planSlots holds each slot's
  // name, cards and fold. A slot is a named group of cards that moves as one. The first version kept a slot's cards
  // after it in prefs.plan, with the slot stored as just its name; that's read the same way. Cards whose item no
  // longer exists (`exists(id)` is false) are dropped, and so are slots with nothing stored.
  const isSlot = e => String(e).startsWith('slot:');
  function planModel(prefs, exists) {
    const stored = prefs.planSlots || {}, entries = [], slots = {}; let legacy = null;
    for (const e of prefs.plan || []) {
      if (isSlot(e) && stored[e] != null) {
        const v = stored[e];
        slots[e] = typeof v === 'object' ? { name: v.name || '', items: (v.items || []).filter(x => exists(x)), collapsed: !!v.collapsed } : { name: String(v), items: [], collapsed: false };
        legacy = typeof v === 'object' ? null : e; entries.push(e);
      } else if (exists(e)) { if (legacy) slots[legacy].items.push(e); else entries.push(e); }
    }
    return { entries, slots };
  }
  /// Every card in order, slots opened up in place.
  const planIDs = m => m.entries.flatMap(e => isSlot(e) ? m.slots[e].items : [e]);

  return {
    SESSION_TYPES, pad, iso, parse, addDays, daysBetween, MONTHS, DOW, hhmm, dm, dow,
    isSession, status, isHandled, inProgress, isGate, profile, state, isOpenish, importance, priorityScore,
    courseFactors, rankScore, rankedTasks, catchUp, weeks, currentWeek, isSlot, planModel, planIDs,
  };
})();
