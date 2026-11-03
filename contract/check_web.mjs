// Runs the shared rule cases (contract/fixtures/rules.json) against the web app's rules, at the fixture's fixed `now`.
//   node contract/check_web.mjs
// Twice: once against rules.js on its own, and once through the page's own bindings in models.js (state, catchUp,
// weeks, dm, planModel…), with every script loaded in order the way index.html loads them, so the page can't drift from rules.js.
// No dependencies and no network; exits 1 if any case fails.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract/fixtures/rules.json'), 'utf8'));
const [y, m, d] = F.now.split('-').map(Number);
const NOW = new Date(y, m - 1, d, 12, 0);   // noon on `now`, local time, like the Swift tests
const STYLE = 'd/MMM';

// A page with no DOM: every document/window call does nothing.
const nothing = new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => '' : nothing), apply: () => nothing });
function page(files) {
  const ctx = vm.createContext({
    window: { APP_CONFIG: {}, supabase: { createClient: () => nothing } }, document: nothing, navigator: {},
    location: { hostname: 'contract-check', search: '' }, URLSearchParams, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    console, structuredClone,
  });
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
// Same JSON with sorted keys, so objects from the page's realm compare by value.
const canon = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

// The rules as one interface, either straight from rules.js or through the page's bindings to its state S (models.js).
function fromRules(ctx) {
  const R = vm.runInContext('Rules', ctx);
  return {
    state: it => R.state(it, NOW, STYLE), importance: R.importance, priority: it => R.priorityScore(it, NOW),
    ranked: (items, courses) => R.rankedTasks(items, courses, NOW), score: (it, courses) => R.rankScore(it, R.courseFactors(courses), NOW),
    catchUp: items => R.catchUp(items, NOW), weeks: prefs => R.weeks(prefs), dm: (s, style) => R.dm(s, style),
    plan: (prefs, ids) => { const p = R.planModel(prefs, x => ids.includes(x)); return { ...p, ids: R.planIDs(p) }; },
  };
}
function fromApp(ctx) {
  const run = (code, vars) => { Object.assign(ctx, vars); return vm.runInContext(code, ctx); };
  const setS = o => run('Object.assign(S, __s)', { __s: { courses: [], items: [], prefs: {}, ...o } });
  return {
    state: it => { setS({ prefs: { dateStyle: STYLE } }); return run('state(__it, __now)', { __it: it, __now: NOW }); },
    importance: it => run('importance(__it)', { __it: it }),
    priority: null,   // the page only uses it through rankedTasks
    ranked: (items, courses) => { setS({ courses }); return run('rankedTasks(__items, __now)', { __items: items, __now: NOW }); },
    score: null,
    catchUp: items => run('catchUp(__items, __now)', { __items: items, __now: NOW }),
    weeks: prefs => { setS({ prefs }); return run('weeks()', {}); },
    dm: (s, style) => { setS({ prefs: { dateStyle: style } }); return run('dm(__d)', { __d: s }); },
    plan: (prefs, ids) => { setS({ prefs, items: ids.map(id => ({ id })) }); return run('({ ...planModel(), ids: planIDs() })', {}); },
  };
}

function check(name, rules) {
  const fails = [], counts = {};
  const expect = (section, ok, what) => { counts[section] = (counts[section] || 0) + 1; if (!ok) fails.push(`${section}: ${what}`); };
  for (const c of F.status) {
    const s = rules.state(c.item);
    expect('status', s.key === c.key && s.text === c.text, `${c.item.id} gave ${s.key} "${s.text}", expected ${c.key} "${c.text}"`);
  }
  for (const c of F.importance) {
    const n = rules.importance(c.item);
    expect('importance', n === c.importance, `${c.item.id} gave ${n}, expected ${c.importance}`);
  }
  if (rules.priority) for (const c of F.priority) {
    const n = rules.priority(c.item);
    expect('priority', near(n, c.score), `${c.item.id} gave ${n}, expected ${c.score}`);
  }
  const R = F.ranking, order = rules.ranked(R.items, R.courses).map(i => i.id);
  expect('ranking', canon(order) === canon(R.order), `order ${order.join(',')}, expected ${R.order.join(',')}`);
  if (rules.score) for (const it of R.items) {
    const n = rules.score(it, R.courses);
    expect('ranking', near(n, R.scores[it.id]), `${it.id} scored ${n}, expected ${R.scores[it.id]}`);
  }
  const C = F.catchUp, cu = rules.catchUp(C.items);
  for (const k of ['handled', 'total', 'behind', 'percent']) expect('catchUp', cu[k] === C[k], `${k} ${cu[k]}, expected ${C[k]}`);
  for (const c of F.weeks) {
    const w = rules.weeks(c.prefs), tag = canon(c.prefs);
    expect('weeks', w.length === c.count, `${tag}: ${w.length} weeks, expected ${c.count}`);
    expect('weeks', w[0]?.ws === c.firstStart && w[0]?.we === c.firstEnd, `${tag}: first week ${w[0]?.ws}..${w[0]?.we}, expected ${c.firstStart}..${c.firstEnd}`);
    for (const [day, n] of Object.entries(c.weekOf)) {
      const got = w.find(x => day >= x.ws && day <= x.we)?.n;
      expect('weeks', got === n, `${tag}: ${day} in week ${got}, expected ${n}`);
    }
  }
  for (const [style, text] of Object.entries(F.dateStyles.styles)) {
    const got = rules.dm(F.dateStyles.date, style);
    expect('dateStyles', got === text, `${style} gave "${got}", expected "${text}"`);
  }
  for (const c of F.plan.cases) {
    const p = rules.plan({ plan: c.plan, planSlots: c.planSlots }, F.plan.items);
    for (const k of ['entries', 'slots', 'ids']) expect('plan', canon(p[k]) === canon(c[k]), `${c.name}: ${k} ${canon(p[k])}, expected ${canon(c[k])}`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${name}: ${total - fails.length}/${total} checks pass (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  return fails.length;
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(x => x[1]);
// rules.js and sync.js come before the data layer, and the router (which starts the app) comes last.
const at = f => order.indexOf(f), inOrder = at('rules.js') >= 0 && at('rules.js') < at('data.js') && at('sync.js') < at('data.js') && at('router.js') === order.length - 1;
console.log(`index.html loads ${order.join(', ')}${inOrder ? '' : '  FAIL: rules.js and sync.js must come before data.js, and router.js last'}`);
// The app's own scripts, in the page's order (config.js and vendor/ are stubbed by page()).
const own = order.filter(f => f !== 'config.js' && !f.startsWith('vendor/'));

let failed = inOrder ? 0 : 1;
failed += check('rules.js', fromRules(page(['rules.js'])));
failed += check('the page (models.js)', fromApp(page(own)));
process.exit(failed ? 1 : 0);
