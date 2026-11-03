// Claude's questions: a few taps that help it rank things (QuestionsModel in the iPhone app).
'use strict';

// ---------- Views ----------
function questionSheet() {
  const q = S.questions.filter(x => (x.status || 'open') === 'open').sort((a, b) => (a.deferred || 0) - (b.deferred || 0))[0];
  if (!q) return '<div class="bar-top"><button class="pill" data-close>Close</button></div><div class="group pad" style="text-align:center">All answered. Thanks, Claude will use your answers on its next run.</div>';
  const body = q.kind === 'rank' ? `<div class="empty">This one asks you to put things in order. Answer it in the iPhone app.</div>`
    : `<div class="menu">${(q.options || []).map(o => `<button class="pill" style="text-align:left;padding:12px 14px" data-answer="${esc(q.id)}" data-opt="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>`;
  return `<div class="bar-top"><button class="pill" data-close>Close</button><button class="pill" data-qskip="${esc(q.id)}">Not now</button></div>
  <div class="group pad"><div style="color:var(--c-purple);font-weight:600;font-size:15px">✦ Claude asks${q.course && course(q.course) ? ` · ${esc(short(course(q.course)))}` : ''}</div><div dir="auto" style="font-size:20px;font-weight:600;margin:8px 0">${esc(q.text)}</div>${q.detail ? `<div style="color:var(--label2);font-size:15px" dir="auto">${esc(q.detail)}</div>` : ''}${body}</div>`;
}

// ---------- Model ----------
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
const skipQuestion = id => optimistic('question', id, q => { q.deferred = (q.deferred || 0) + 1; return q; });
