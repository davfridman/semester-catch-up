// Overview: how caught up you are, the course rings, Claude's questions, the top feed card and the plan, tasks
// and lectures lists; and the Progress screen (OverviewModel in the iPhone app).
'use strict';

function overview() {
  const items = visibleItems(), s = catchUp(items), w = currentWeek();
  const courses = visibleCourses(), n = courses.length, cols = n <= 4 ? Math.max(n, 1) : [5, 6, 9].includes(n) ? 3 : 4;
  const tasks = rankedTasks(items), lectures = items.filter(i => isSession(i) && isOpenish(i)).sort((a, b) => (inProgress(a) ? 0 : 1) - (inProgress(b) ? 0 : 1) || a.date.localeCompare(b.date));
  const plan = planItems().filter(i => !isHandled(i)), cards = feedCards(), qs = S.questions.filter(q => (q.status || 'open') === 'open');
  const list = S.list === 'plan' ? cardsOr(plan.slice(0, 8), 'Nothing planned. Open a task and tap the plan button.', { showPlanTag: false })
    : S.list === 'tasks' ? cardsOr(tasks, 'Nothing open right now.') : cardsOr(lectures, 'You’re caught up on lectures.');
  return `<div class="head"><div><div class="sub">${esc(longDate())}</div><h1>Overview</h1></div><div class="hbtns"><button class="hbtn" data-go="chat" aria-label="Chat with Claude" title="Chat with Claude"><span style="font-size:18px">✦</span></button><button class="hbtn" data-go="notes" aria-label="Your notes" title="Your notes">${ROW_ICONS.note}</button></div></div>
  <div class="group pad"><button class="rings-top" style="width:100%" data-go="progress"><b>${s.percent}</b><span style="color:var(--label2);font-size:15px">caught up</span><span style="flex:1"></span><span style="color:var(--label2);font-size:15px">Week ${w.n} of ${weeks().length}</span></button>
    <div class="rings" style="grid-template-columns:repeat(${cols},1fr)">${courses.map(c => { const cs = catchUp(items.filter(i => i.c === c.id)); return `<button class="ring-item" data-course="${esc(c.id)}" aria-label="${esc(displayName(c))}, ${cs.percent} caught up">${ringWithText(cs.fraction, 52, 6, color(c.id), cs.percent, 11)}<span class="name" style="color:${color(c.id)}">${esc(short(c))}</span><span class="meta">${cs.behind ? `${cs.behind} to watch` : 'caught up'}</span></button>`; }).join('')}</div></div>
  ${qs.length ? `<button class="group pad qbanner" style="width:100%;text-align:left" data-sheet="questions"><span class="spark">✦</span><span class="grow"><b>${qs.length === 1 ? 'Claude has a question' : `Claude has ${qs.length} questions`}</b><br><span style="color:var(--label2);font-size:15px">A few taps help Claude rank things for you</span></span><span style="color:var(--accent);font-weight:600">Answer</span></button>` : ''}
  <div class="feed-head"><h3>For you</h3><button style="color:var(--accent);font-weight:600;font-size:15px" data-go="feed">${cards.length ? `${cards.length} new ›` : 'History ›'}</button></div>
  ${cards.length ? feedCard(cards[0], cards.length > 1) : `<div class="fcard" style="cursor:default"><span style="color:var(--green)">✓</span> You’re all caught up on updates.</div>`}
  <div class="tray">${seg('list', [['plan', `Plan · ${plan.length}`], ['tasks', `Tasks · ${tasks.length}`], ['lectures', `Lectures · ${lectures.length}`]], S.list)}${list}
    ${S.list === 'plan' ? `<button class="row" data-go="plan" style="color:var(--accent);font-weight:500">${plan.length > 8 ? `All ${plan.length} in your plan` : 'Open your plan'}<span class="grow"></span><span class="chev"></span></button>` : ''}</div>`;
}
function progressScreen() {
  const all = catchUp(visibleItems());
  return `<button class="back" data-back>‹ Overview</button><div class="head"><h2>Progress</h2></div>
  <div class="group pad metrics">${ringWithText(all.fraction, 96, 11, 'var(--green)', all.percent, 20)}<div><b>Caught up</b><div style="color:var(--label2);font-size:15px">${all.behind} lectures to watch. Lectures held and deadlines passed, weighted by how much they matter. Going over the material counts half.</div></div></div>
  <div class="group">${visibleCourses().map(c => { const its = visibleItems().filter(i => i.c === c.id), s = catchUp(its), a = attendance(its); return `<button class="row" data-course="${esc(c.id)}">${ringWithText(s.fraction, 40, 5, color(c.id), s.percent, 9)}<span class="grow"><b style="color:${color(c.id)}">${esc(displayName(c))}</b><br><span style="color:var(--label2);font-size:13px">${s.behind ? `${s.behind} to watch` : 'caught up'}${a.attended ? ` · attended ${a.attended}/${a.held}` : ''}</span></span><span class="chev"></span></button>`; }).join('')}</div>`;
}
