// The feed: updates from the syncs and Claude's insights (FeedModel in the iPhone app). The cards themselves are
// read in models.js (feedCards) and drawn by ui.js (feedCard); this file marks them seen and draws the updates screen.
'use strict';

// ---------- Model ----------
const markSeen = ids => ids.forEach(id => optimistic('update', id, d => { d.seen = true; return d; }));
function seenCard(c) {
  if (c.kind === 'update') markSeen([c.u.id]);
  else if (c.kind === 'claude') optimistic('insight', c.i.id, d => { d.dismissed = true; return d; });
}
/// Seen, by card id; a card that just left the list (its sheet is still open) is found as the last one opened.
function seenCardById(id) { const c = feedCards().find(x => x.id === id) || S.lastCard; if (c) seenCard(c); }
const markAllSeen = () => { feedCards().forEach(seenCard); };
/// Leaving a course's announcements marks them read.
function markAnnouncementsSeen(courseId) {
  const unseen = S.updates.filter(u => u.kind === 'announcement' && u.course === courseId && !u.seen).map(u => u.id);
  if (unseen.length) markSeen(unseen);
}

// ---------- Views ----------
function feedScreen() {
  const cards = feedCards();
  const earlier = [...S.updates.filter(u => u.seen && u.kind !== 'announcement'), ...S.insights.filter(i => i.kind !== 'brief')]
    .filter(x => !cards.some(c => c.id.endsWith(':' + x.id))).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 60);
  return `<button class="back" data-back>‹ Overview</button><div class="head"><h2>Updates & insights</h2>${cards.length ? '<button class="pill" data-allseen>Mark all seen</button>' : ''}</div>
  <div class="sec">New · ${cards.length}</div>${cards.length ? cards.map(c => feedCard(c)).join('') : '<div class="empty">Nothing new. You’re all caught up.</div>'}
  ${earlier.length ? `<div class="sec">Earlier</div><div class="group">${earlier.map(x => `<div class="row" style="align-items:flex-start"><span class="ico">${x.kind ? (UPDATE_META[x.kind]?.[0] || '•') : '✦'}</span><div class="grow"><div style="font-size:12px;color:var(--label2)">${esc(x.kind ? (UPDATE_META[x.kind]?.[1] || 'Update') : 'Claude')} · ${esc(ago(x.at))}</div><div dir="auto">${esc(x.text)}</div></div></div>`).join('')}</div>` : ''}`;
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
