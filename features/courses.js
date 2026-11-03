// Courses: the course list, a course's page with its weeks, the week sheet, announcements and grading (CoursesModel).
'use strict';

// The Courses tab: every course with how caught up it is.
function coursesScreen() {
  const row = c => { const its = S.items.filter(i => i.c === c.id && !i.hidden), s = catchUp(its), open = its.filter(i => !isSession(i) && isOpenish(i)).length;
    return `<button class="row" data-course="${esc(c.id)}">${ringWithText(s.fraction, 42, 5, color(c.id), s.percent, 10)}<span class="grow"><span style="display:block">${esc(c.name)}</span><span style="font-size:15px;color:var(--label2)"><span style="color:${color(c.id)}">${esc(short(c))}</span>${s.behind ? ` · ${s.behind} to watch` : ''}${open ? ` · ${open} open` : ''}</span></span><span class="chev"></span></button>`; };
  const hidden = S.courses.filter(c => profile(c).hidden);
  return `<div class="head"><div><div class="sub">${visibleCourses().length} this semester</div><h1>Courses</h1></div></div>
  <div class="group">${visibleCourses().map(row).join('') || '<div class="row val">No courses yet.</div>'}</div>
  ${hidden.length ? `<div class="group-title">Hidden</div><div class="group" style="opacity:.55">${hidden.map(row).join('')}</div><div class="group-foot">Hidden courses are left out of Overview, Schedule and the score.</div>` : ''}`;
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
