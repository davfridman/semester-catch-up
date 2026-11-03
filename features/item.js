// A task or lecture: its status, progress, note and "How did it go?" (ItemModel in the iPhone app), and its sheets.
'use strict';

// ---------- Model ----------
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
/// The circle on a card: done, or back to to do.
function toggleDone(id) { const it = item(id); return setStatus(id, isHandled(it) ? 'todo' : 'done'); }
/// "Watched up to": minutes into the recording. Watching all of it marks it watched.
function saveProgress(id, v) {
  const it = item(id);
  patch('item', id, x => { if (v > 0) x.stopAt = clock(v * 60); else delete x.stopAt; if (v > 0 && (x.status || 'todo') === 'todo') x.status = 'progress'; if (v === 0 && x.status === 'progress') x.status = 'todo'; return x; });
  if (it && v >= (it.duration || 90)) setStatus(id, 'done');
}
/// Your note: it's yours from now on (locked), so the syncs and Claude leave it alone.
function saveNote(id, v) { patch('item', id, x => { x.note = v; x.locked = [...new Set([...(x.locked || []), 'note'])].sort(); return x; }); }
// "How did it go?": the answers live on the sheet (s.a) until you save or skip.
function chooseReflection(s, key, v) { s.a = s.a || {}; s.a[key] = s.a[key] === v ? undefined : v; }
function setReflectionNote(s, text) { s.a = s.a || {}; s.a.note = text; }
const skipReflection = id => patch('item', id, x => { x.reflection = { skipped: true, at: today() }; return x; });
function saveReflection(s) {
  const r = { at: today() };
  for (const k of ['difficulty', 'minutes', 'followed']) if (s.a?.[k] != null) r[k] = s.a[k];
  if (s.a?.note?.trim()) r.note = s.a.note.trim();
  return patch('item', s.id, x => { x.reflection = r; return x; });
}

// ---------- Views ----------
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
