// The router: which screen and sheet are showing (S.tab, S.route, S.sheet), the one place that turns taps and
// typing into calls to the features, and the start of the app. Features never call each other; they render
// data-* attributes, and this file sends each tap to the feature it belongs to. Loaded last, after every feature.
'use strict';

// ---------- Sheets ----------
function openSheet(s) { S.sheet = s; renderSheet(); }
function closeSheet() { S.sheet = null; $('#layer').innerHTML = ''; }
const SHEETS = { item: s => itemSheet(s.id), reflect: s => reflectSheet(s), card: s => cardSheet(s.id), questions: () => questionSheet(), week: s => weekSheet(s), cardmenu: s => planCardMenuSheet(s), slot: s => planSlotSheet(s) };
function renderSheet() {
  const s = S.sheet; if (!s) { $('#layer').innerHTML = ''; return; }
  const html = SHEETS[s.kind]?.(s) || '';
  $('#layer').innerHTML = `<div class="scrim" data-scrim><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
}

// ---------- Screens ----------
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
  else if (r === 'plan') html = planScreen();
  else if (r === 'chat') html = chatScreen();
  else html = { overview, schedule: scheduleScreen, courses: coursesScreen, settings: settingsScreen }[S.tab]();
  $('#app').innerHTML = html;
  const tabs = $('#tabs'); tabs.classList.remove('hidden');
  tabs.innerHTML = [['overview', 'Overview'], ['schedule', 'Schedule'], ['courses', 'Courses'], ['settings', 'Settings']].map(([k, l]) => `<button class="${S.tab === k && !S.route.length ? 'on' : S.tab === k ? 'on' : ''}" data-tab="${k}" aria-label="${l}">${ICONS[k]}<span>${l}</span></button>`).join('');
  if (S.tab === 'schedule' && !S.route.length) document.getElementById('d-' + (S.day || today()))?.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (S.sheet) renderSheet();
}
function go(route) { S.route.push(route); window.scrollTo(0, 0); render(); }
function back() {
  const r = S.route.pop();
  if (r?.startsWith('news:')) markAnnouncementsSeen(r.slice(5));   // leaving a course's announcements marks them read
  render();
}
// The data layer redraws and speaks through these.
dataEvents.changed = () => { applyTheme(); render(); };
dataEvents.message = msg => toast(msg);

// ---------- Taps ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-open], [data-card], [data-scrim], a'); if (!t) return;
  const d = t.dataset;
  if (d.scrim !== undefined && e.target === t) return closeSheet();
  if (d.toggle) { e.stopPropagation(); return toggleDone(d.toggle); }
  if (d.seen) { e.stopPropagation(); seenCardById(d.seen); if (S.sheet?.kind === 'card') closeSheet(); return; }
  if (d.open) { if (t.tagName === 'A') return; return openSheet({ kind: 'item', id: d.open }); }
  if (d.openitem) return openSheet({ kind: 'item', id: d.openitem });
  if (d.card) return openSheet({ kind: 'card', id: d.card });
  if (d.week) return openSheet({ kind: 'week', c: S.route[S.route.length - 1].slice(7), ws: d.week });
  if (d.tab) { S.tab = d.tab; S.route = []; closeSheet(); window.scrollTo(0, 0); return render(); }
  if (d.go) { closeSheet(); return go(d.go); }
  if (d.back !== undefined) return back();
  if (d.course) { closeSheet(); S.tab = S.tab === 'courses' && !S.route.length ? 'courses' : 'overview'; S.route = [`course:${d.course}`]; S.courseTab = 'tasks'; window.scrollTo(0, 0); return render(); }
  if (d.seg) { S[d.seg] = d.val; return render(); }
  if (d.day) { closeSheet(); S.day = d.day === 'today' ? null : d.day; S.tab = 'schedule'; S.route = []; return render(); }
  if (d.close !== undefined) return closeSheet();
  if (d.status) { setStatus(d.status, d.val); if (S.sheet?.kind === 'item' && !(['done', 'attended', 'reviewed'].includes(d.val))) renderSheet(); else if (S.sheet?.kind === 'item') closeSheet(); return; }
  if (d.plan) { if (S.sheet?.kind === 'cardmenu') closeSheet(); togglePlan(d.plan); return; }
  if (d.pmove) return movePlanEntry(d.pmove, Number(d.dir));
  if (d.cleardone !== undefined) return clearDone();
  if (d.slotfold) return foldSlot(d.slotfold);
  if (d.cardmenu) return openSheet({ kind: 'cardmenu', id: d.cardmenu });
  if (d.toslot) { closeSheet(); return moveToSlot(d.toslot, d.slot || null); }
  if (d.addslot !== undefined) return addSlot();
  if (d.slotmenu) return openSheet({ kind: 'slot', id: d.slotmenu });
  if (d.slotrename) { closeSheet(); return renameSlot(d.slotrename); }
  if (d.slotdel) { closeSheet(); return deleteSlot(d.slotdel); }
  if (d.slotask) { closeSheet(); askAboutSlot(d.slotask); return go('chat'); }
  if (d.addall) return addAllToPlan(d.addall.split(','));
  if (d.unattach !== undefined) { unattachCards(); return render(); }
  if (d.chatsend !== undefined) return sendChat();
  if (d.allseen !== undefined) return markAllSeen();
  if (d.sheet === 'questions') return openSheet({ kind: 'questions' });
  if (d.answer) { answerQuestion(d.answer, d.opt); return renderSheet(); }
  if (d.qskip) { skipQuestion(d.qskip); return renderSheet(); }
  if (d.chip) { chooseReflection(S.sheet, d.chip, Number(d.val)); return renderSheet(); }
  if (d.reflectSkip !== undefined) { const s = S.sheet; closeSheet(); return skipReflection(s.id); }
  if (d.reflectSave !== undefined) { const s = S.sheet; closeSheet(); return saveReflection(s); }
  if (d.signout !== undefined) { signOut(); return; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) closeSheet(); if (e.key === 'Enter' && e.target.matches('[data-open],[data-card]')) e.target.click(); });

// ---------- Typing and fields ----------
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.stop) { const v = Number(t.value); $('#mins').textContent = `${v} of ${item(t.dataset.stop)?.duration || 90} min`; }
  if (t.dataset.reflectNote !== undefined) setReflectionNote(S.sheet, t.value);
  if (t.dataset.chatdraft !== undefined) { setChatDraftText(t.value); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  if (t.dataset.notesq !== undefined) { setNotesQuery(t.value); render(); const q = $('[data-notesq]'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.stop) saveProgress(t.dataset.stop, Number(t.value));
  if (t.dataset.note) saveNote(t.dataset.note, t.value);
  if (t.dataset.pref) changePref(t.dataset.pref, t.value);
});

// ---------- Start ----------
// Keep in step with the iPhone app and the syncs: reload when the page comes back, and every 2 minutes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user && !S.sheet) load();
  if (document.visibilityState === 'hidden') saveNow();   // leaving the page: save what's waiting now
});
setInterval(() => { if (document.visibilityState === 'visible' && S.user && !S.sheet) load(); }, 120000);
watchAccount(() => {
  if (!S.user) { S.loaded = false; return render(); }
  S.loaded = false; render(); load();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
