// Schedule: the semester's days as a strip, and what's on the chosen day (ScheduleModel in the iPhone app).
'use strict';

// Under each day, like Calendar: one dot per course with something that day, in its color, up to three.
// A red dot first on an exam day. A course's dot fades once everything of it that day is done.
function dayDots(es) {
  const exam = es.some(x => x.kind === 'due' && isExam(x.it)), rest = es.filter(x => !(x.kind === 'due' && isExam(x.it)));
  const ids = visibleCourses().map(c => c.id).filter(c => rest.some(x => x.it.c === c)).slice(0, exam ? 2 : 3);
  return `<span class="dots">${exam ? '<span class="dot" style="background:var(--red)"></span>' : ''}${ids.map(c => `<span class="dot" style="background:${color(c)};opacity:${rest.filter(x => x.it.c === c).every(x => isHandled(x.it)) ? .3 : 1}"></span>`).join('')}</span>`;
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
  <div class="day-strip" id="strip">${days.map(x => { const es = ev(x), due = es.some(y => y.kind === 'due'); return `<button class="day ${x === d ? 'on' : ''} ${x === today() ? 'today' : ''}" data-day="${x}" id="d-${x}">${DOW[parse(x).getDay()]}<b>${parse(x).getDate()}</b>${dayDots(es)}</button>`; }).join('')}</div>
  ${tasks.length ? `<div class="sec">Tasks</div>${cardsOr(tasks.sort(byTime).map(x => x.it), '', { trailing: 'time' })}` : ''}
  ${lect.length ? `<div class="sec">Lectures</div>${cardsOr(lect.sort(byTime).map(x => x.it), '', { trailing: 'time' })}` : ''}
  ${!e.length ? '<div class="empty" style="text-align:center;padding:40px 0">Nothing on this day.</div>' : ''}`;
}
