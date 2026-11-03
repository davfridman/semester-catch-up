// The plan: your order of work, with slots like "Sunday morning" (PlanModel in the iPhone app). Reading the plan is
// shared (models.js: planModel, planIDs, inPlan, slotOf); this file changes it and draws the Plan screen and its sheets.
'use strict';

// ---------- Model: changing the plan ----------
const savePlan = m => optimistic('settings', 'prefs', p => { p.plan = m.entries; p.planSlots = m.slots; return p; });
function togglePlan(id) {
  const m = planModel();
  if (inPlan(id)) { m.entries = m.entries.filter(x => x !== id); for (const k in m.slots) m.slots[k].items = m.slots[k].items.filter(x => x !== id); }
  else m.entries.push(id);
  savePlan(m);
}
// Up or down one place: on the top level a card or a whole slot; inside a slot, within it.
function movePlanEntry(e, dir) {
  const m = planModel(), s = isSlot(e) ? null : slotOf(e), list = s ? m.slots[s].items : m.entries, i = list.indexOf(e), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]]; savePlan(m);
}
// Into a slot (at its end), or out of one (null: just below the slot it was in).
function moveToSlot(id, target) {
  const m = planModel(), from = slotOf(id); if (from === target) return;
  m.entries = m.entries.filter(x => x !== id); if (from) m.slots[from].items = m.slots[from].items.filter(x => x !== id);
  if (target) m.slots[target].items.push(id);
  else { const at = from ? m.entries.indexOf(from) + 1 : m.entries.length; m.entries.splice(at, 0, id); }
  savePlan(m);
}
function addSlot() {
  const name = (prompt('Name the slot, like “Sunday morning”. Then move cards into it with ⋯ on a card.') || '').trim(); if (!name) return;
  const m = planModel(), id = 'slot:' + Math.random().toString(36).slice(2, 10);
  m.slots[id] = { name, items: [], collapsed: false }; m.entries.unshift(id); savePlan(m);
}
function renameSlot(id) {
  const m = planModel(), name = (prompt('Rename the slot', m.slots[id]?.name || '') || '').trim(); if (!name) return;
  m.slots[id].name = name; savePlan(m);
}
const foldSlot = id => { const m = planModel(); m.slots[id].collapsed = !m.slots[id].collapsed; savePlan(m); };
// Deleting a slot keeps its cards: they take its place in the plan.
function deleteSlot(id) { const m = planModel(), i = m.entries.indexOf(id); if (i < 0) return; m.entries.splice(i, 1, ...m.slots[id].items); delete m.slots[id]; savePlan(m); }
function clearDone() { const m = planModel(), open = x => !isHandled(item(x)); m.entries = m.entries.filter(e => isSlot(e) || open(e)); for (const k in m.slots) m.slots[k].items = m.slots[k].items.filter(open); savePlan(m); }
/// Adds cards (from a Claude reply) to the end of the plan, skipping those already in it.
function addAllToPlan(add) {
  const m = planModel(); m.entries.push(...add.filter(x => !inPlan(x))); savePlan(m);
  toast(add.length === 1 ? 'Added to your plan' : `Added ${add.length} to your plan`);
}

// ---------- Dragging ----------
// Hold a card or a slot and drag, like the iPhone app (DesignSystem/DragReorder): it lifts and follows the finger,
// a gap opens where it will land and the rest slide aside on a spring. A card dropped inside a slot's box goes among
// its cards (a folded slot takes it at the end), elsewhere on the top level; a slot folds while carried and moves
// as one. Touch lifts after a 0.3 s hold (moving first is a scroll); a mouse lifts as soon as it moves. Near the top
// or bottom edge the page scrolls. Nothing is saved until it's dropped. The router sends the pointer events here.
let planDrag = null;   // { id, isSlot, draft, wasCollapsed, grab, x, y, clone, settling }
let planPress = null;  // a press that may become a drag
let planJustDropped = false;

/// SwiftUI's .snappy(duration: 0.35) (a spring with a touch of bounce) as a CSS easing, for the gap and the drop.
const PLAN_SPRING = (() => {
  const T = 0.45, z = 0.85, w = 2 * Math.PI / 0.35, wd = w * Math.sqrt(1 - z * z);
  const at = t => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t));
  const pts = Array.from({ length: 41 }, (_, i) => i === 40 ? '1' : at(i / 40 * T).toFixed(4));
  return window.CSS?.supports?.('transition-timing-function', 'linear(0, 1)')
    ? { duration: T * 1000, easing: `linear(${pts.join(', ')})` } : { duration: 350, easing: 'cubic-bezier(.2, .9, .3, 1)' };
})();

const planEls = () => [...document.querySelectorAll('#app [data-pid]')];
const planGap = () => planEls().find(el => el.dataset.pid === planDrag?.id);
/// Redraws the plan and slides everything from where it was to where it is now (a slot's box grows or shrinks too).
function planRedraw(draw = render) {
  const before = new Map(planEls().map(el => [el.dataset.pid, el.getBoundingClientRect()]));
  draw();
  for (const el of planEls()) {
    const o = before.get(el.dataset.pid); if (!o) continue;
    const r = el.getBoundingClientRect(), up = el.parentElement.closest('[data-pid]');
    // A card inside a slot moves with its slot; only its own part of the move is animated.
    const po = up && before.get(up.dataset.pid), pr = up?.getBoundingClientRect();
    const dx = o.left - r.left - (po ? po.left - pr.left : 0), dy = o.top - r.top - (po ? po.top - pr.top : 0);
    if (Math.abs(dx) + Math.abs(dy) > 0.5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], PLAN_SPRING);
    if (!isSlot(el.dataset.pid) || Math.abs(o.height - r.height) < 0.5) continue;
    if (r.height > o.height) el.animate([{ clipPath: `inset(0 0 ${r.height - o.height}px 0 round 22px)` }, { clipPath: 'inset(0 0 0 0 round 22px)' }], PLAN_SPRING);
    else { const c = getComputedStyle(el).backgroundColor; el.animate([{ boxShadow: `0 ${o.height - r.height}px 0 0 ${c}` }, { boxShadow: `0 0 0 0 ${c}` }], PLAN_SPRING); }
  }
}

function planPointerDown(e) {
  const el = e.target.closest?.('#app [data-pid]');
  if (!el || planDrag || e.button > 0 || e.target.closest('[data-pmove],[data-cardmenu],[data-slotmenu]')) return;
  planPress = { el, id: el.dataset.pid, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' };
  if (!planPress.mouse) planPress.timer = setTimeout(() => planLift(), 300);
}
function planPointerMove(e) {
  if (planDrag) { if (!planDrag.settling) planFollow(e.clientX, e.clientY); return; }
  if (!planPress) return;
  const far = Math.hypot(e.clientX - planPress.x, e.clientY - planPress.y);
  if (planPress.mouse && far > 5) { planLift(); planFollow(e.clientX, e.clientY); }
  else if (!planPress.mouse && far > 8) planCancelPress();   // it's a scroll
}
function planPointerUp() { if (planPress) planCancelPress(); else if (planDrag) planDrop(); }
const planCancelPress = () => { clearTimeout(planPress?.timer); planPress = null; };
/// While carrying: no page scroll under the finger, no callout menu, and the click after a drop isn't a tap.
const planCarrying = () => !!planDrag;
const planHolding = () => !!(planDrag || planPress);
const planSwallowsClick = () => planJustDropped;

function planLift() {
  const p = planPress; planCancelPress();
  if (!p?.el.isConnected) return;
  const m = planModel(), slot = isSlot(p.id), r0 = p.el.getBoundingClientRect();
  if (slot && !m.slots[p.id]) return;
  const wasCollapsed = slot ? m.slots[p.id].collapsed : false;
  if (slot) m.slots[p.id].collapsed = true;   // a slot folds while it's carried
  planDrag = { id: p.id, isSlot: slot, draft: m, wasCollapsed, x: p.x, y: p.y };
  planRedraw();
  const gap = planGap(); if (!gap) { planDrag = null; return render(); }
  const r = gap.getBoundingClientRect(), clone = gap.cloneNode(true);
  clone.classList.add('plan-lifted'); clone.style.visibility = ''; clone.style.width = r.width + 'px';
  clone.removeAttribute('data-pid'); clone.querySelectorAll('[data-pid]').forEach(x => x.removeAttribute('data-pid'));
  document.body.append(clone);
  planDrag.clone = clone;
  planDrag.grab = { x: p.x - r0.left, y: Math.min(p.y - r0.top, r.height - 20) };
  planPosition();
  clone.animate([{ scale: '1', filter: 'none' }, { scale: '1.03' }], PLAN_SPRING);
  navigator.vibrate?.(8);
  planAutoScroll();
}
const planPosition = () => { const d = planDrag; d.clone.style.transform = `translate(${d.x - d.grab.x}px, ${d.y - d.grab.y}px)`; };

/// The carried one follows the finger exactly; when the place it would land changes, the draft moves and the rest
/// slide aside.
function planFollow(x, y) {
  const d = planDrag; d.x = x; d.y = y; planPosition();
  const next = Rules.planMoving(d.draft, d.id, planPlaceAt(x, y));
  if (JSON.stringify(next) === JSON.stringify(d.draft)) return;
  d.draft = next; navigator.vibrate?.(4);
  planRedraw();
  const gap = planGap(); if (gap) d.clone.style.width = gap.getBoundingClientRect().width + 'px';
}

/// Where the carried one lands if dropped at (x, y): among a slot's cards when a card is over a slot's box,
/// otherwise on the top level. Measured against what's on screen, leaving the carried one out so the gap doesn't
/// chase the finger. Indexes are in the draft without the carried one, which also counts hidden cards.
/// Where an element sits once it stops moving (in the window's coordinates): its layout box, which leaves out the
/// slide-aside animations, so the landing place doesn't flicker while things are still on their way.
function planLayoutRect(el) {
  let top = 0, left = 0;
  for (let e = el; e; e = e.offsetParent) { top += e.offsetTop; left += e.offsetLeft; }
  top -= scrollY; left -= scrollX;
  return { top, left, bottom: top + el.offsetHeight, right: left + el.offsetWidth, height: el.offsetHeight };
}
function planPlaceAt(x, y) {
  const d = planDrag, mine = el => el.dataset.pid !== d.id;
  const without = Rules.planMoving(d.draft, d.id, { top: 0 }); without.entries.shift();
  const index = (els, list) => { const after = els.find(el => { const r = planLayoutRect(el); return r.top + r.height / 2 >= y; });
    return after ? list.indexOf(after.dataset.pid) : list.length; };
  const top = [...document.querySelectorAll('#app .plan-list > [data-pid]')].filter(mine);
  if (!d.isSlot) {
    // The top and bottom 22 px of a slot's box count as outside it, so a card lands loose between two slots easily.
    const box = top.find(el => { const r = planLayoutRect(el), edge = Math.min(22, r.height / 4);
      return isSlot(el.dataset.pid) && x >= r.left && x <= r.right && y >= r.top + edge && y <= r.bottom - edge; });
    if (box) { const s = box.dataset.pid, items = without.slots[s].items;
      return { slot: s, at: without.slots[s].collapsed ? items.length : index([...box.querySelectorAll('[data-pid]')].filter(mine), items) }; }
  }
  return { top: index(top, without.entries) };
}

/// Near the top or bottom edge (above the tab bar) the page scrolls, and the carried one goes with the finger.
function planAutoScroll() {
  const d = planDrag; if (!d || d.settling) return;
  const edge = 80, h = innerHeight - 70, y = d.y;
  const step = y < edge ? -(edge - y) / 6 : y > h - edge ? (y - (h - edge)) / 6 : 0;
  if (step) { const from = scrollY; scrollBy(0, step); if (scrollY !== from) planFollow(d.x, d.y); }
  requestAnimationFrame(planAutoScroll);
}

/// It springs into its gap and shrinks back, then the real one takes its place and the plan is saved. A slot that
/// folded while carried opens again.
function planDrop() {
  const d = planDrag; if (d.settling) return;
  d.settling = true; planJustDropped = true; setTimeout(() => { planJustDropped = false; }, 300);
  navigator.vibrate?.(12);
  const done = () => {
    d.clone.remove(); planDrag = null;
    if (d.isSlot && d.draft.slots[d.id]) d.draft.slots[d.id].collapsed = d.wasCollapsed;
    planRedraw(() => savePlan(d.draft));
  };
  const gap = planGap();
  if (!gap) { d.clone.animate([{ opacity: 1 }, { opacity: 0 }], 150).onfinish = done; return; }   // into a folded slot
  const r = gap.getBoundingClientRect();
  const a = d.clone.animate([{ scale: '1.03' }, { transform: `translate(${r.left}px, ${r.top}px)`, scale: '1', filter: 'none' }], { ...PLAN_SPRING, fill: 'forwards' });
  a.onfinish = done;
}

// ---------- Views ----------
function planScreen() {
  const m = planDrag?.draft || planModel(), ids = Rules.planIDs(m), plan = planItems(), open = plan.filter(i => !isHandled(i)).length;
  // The carried card's gap; loose next to a slot it opens a little wider, so it's clearly a place to drop.
  const nearSlot = k => k >= 0 && (isSlot(m.entries[k - 1] ?? '') || isSlot(m.entries[k + 1] ?? ''));
  const gap = (id, k = -1) => planDrag?.id === id ? `visibility:hidden${nearSlot(k) ? ';margin:6px 0' : ''}` : '';
  const btn = (attrs, label, text) => `<button class="round" style="width:32px;height:32px;font-size:14px" ${attrs} aria-label="${label}" title="${label}">${text}</button>`;
  // The number, with ⋯ (move to a slot, take out, remove) under it; ↑ ↓ on the right.
  const num = id => `<span class="pnum"><b>${ids.indexOf(id) + 1}</b><button data-cardmenu="${esc(id)}" aria-label="More" title="Move to a slot, take out, remove">⋯</button></span>`;
  const cardRow = (it, list, k) => `<div data-pid="${esc(it.id)}" style="display:flex;gap:6px;align-items:center;${gap(it.id, list === m.entries ? k : -1)}">${num(it.id)}<div style="flex:1;min-width:0">${card(it, { showPlanTag: false })}</div>
    <div style="display:grid;gap:2px">${btn(`data-pmove="${esc(it.id)}" data-dir="-1" ${k === 0 ? 'disabled' : ''}`, 'Move up', '↑')}${btn(`data-pmove="${esc(it.id)}" data-dir="1" ${k === list.length - 1 ? 'disabled' : ''}`, 'Move down', '↓')}</div></div>`;
  const bar = its => { const cs = [...new Set(its.map(i => i.c))];
    return `<div class="slot-bar">${cs.map(c => { const mine = its.filter(i => i.c === c), d = mine.filter(isHandled).length;
      return `<span style="flex:${mine.length};background:color-mix(in srgb, ${color(c)} 25%, transparent)" title="${esc(short(course(c)))}: ${d} of ${mine.length} done"><i style="width:${d / mine.length * 100}%;background:${color(c)}"></i></span>`; }).join('')}</div>`; };
  const rows = m.entries.map((e, k) => {
    if (!isSlot(e)) { const it = item(e); return it.hidden ? '' : cardRow(it, m.entries, k); }
    const sl = m.slots[e], its = sl.items.map(item).filter(i => i && !i.hidden), done = its.filter(isHandled).length;
    return `<div class="slot" data-pid="${esc(e)}" style="${gap(e)}"><div class="slot-head"><button class="grow slot-fold" data-slotfold="${esc(e)}" aria-expanded="${!sl.collapsed}"><span class="chev ${sl.collapsed ? '' : 'open'}"></span><span><b>${esc(sl.name)}</b><small>${its.length ? done === its.length ? `All ${its.length} done` : `${done} of ${its.length} done` : 'Empty'}</small></span></button>
      ${btn(`data-pmove="${esc(e)}" data-dir="-1" ${k === 0 ? 'disabled' : ''}`, 'Move slot up', '↑')}${btn(`data-pmove="${esc(e)}" data-dir="1" ${k === m.entries.length - 1 ? 'disabled' : ''}`, 'Move slot down', '↓')}${btn(`data-slotmenu="${esc(e)}"`, `${esc(sl.name)} options`, '⋯')}</div>
      ${its.length ? bar(its) : ''}${sl.collapsed ? '' : its.length ? `<div class="cards">${its.map((it, j) => cardRow(it, its, j)).join('')}</div>` : '<div class="slot-empty">Drag cards here, or use ⋯ on a card.</div>'}</div>`;
  }).join('');
  return `<button class="back" data-back>‹ Overview</button><div class="head"><div><div class="sub">${plan.length ? `${open} to go${plan.length - open ? ` · ${plan.length - open} done` : ''}` : 'Your order of work'}</div><h2>Plan</h2></div>
  <div class="hbtns">${plan.length > open ? '<button class="pill" data-cleardone>Clear done</button>' : ''}<button class="pill" data-addslot>+ Slot</button></div></div>
  ${m.entries.length ? `<div class="cards plan-list">${rows}</div><p class="plan-hint">Hold a card or a slot and drag. Drop a card inside a slot to put it there.</p>`
    : '<div class="group pad" style="text-align:center"><b>No plan yet</b><p style="color:var(--label2)">Put the tasks and lectures you want to get through in order. Open any card and tap the plan button. Group them into slots like “Sunday morning” with + Slot.</p></div>'}`;
}
/// ⋯ on a card in the plan: move it to a slot, take it out of one, or remove it from the plan.
function planCardMenuSheet(s) {
  const m = planModel(), from = slotOf(s.id), it = item(s.id);
  return `<div class="bar-top"><b dir="auto">${esc(it?.title || '')}</b><button class="pill" data-close>Done</button></div>
    <div class="group">${m.entries.filter(e => isSlot(e) && e !== from).map(e => `<button class="row" data-toslot="${esc(s.id)}" data-slot="${esc(e)}"><span class="ico">▤</span><span class="grow">Move to ${esc(m.slots[e].name)}</span></button>`).join('')}
    ${from ? `<button class="row" data-toslot="${esc(s.id)}" data-slot=""><span class="ico">↗</span><span class="grow">Take out of ${esc(m.slots[from].name)}</span></button>` : ''}
    <button class="row" data-plan="${esc(s.id)}" style="color:var(--red)"><span class="ico" style="color:var(--red)">−</span><span class="grow">Remove from plan</span></button></div>`;
}
/// ⋯ on a slot: rename it, ask Claude about it, or delete it (its cards stay in the plan).
const planSlotSheet = s => `<div class="bar-top"><b>${esc(slotNames()[s.id] || '')}</b><button class="pill" data-close>Done</button></div>
    <div class="group"><button class="row" data-slotrename="${esc(s.id)}"><span class="ico">✎</span><span class="grow">Rename</span></button><button class="row" data-slotask="${esc(s.id)}"><span class="ico">✦</span><span class="grow">Ask Claude about it</span></button><button class="row" data-slotdel="${esc(s.id)}" style="color:var(--red)"><span class="ico" style="color:var(--red)">✕</span><span class="grow">Delete slot (keeps the cards)</span></button></div>`;
