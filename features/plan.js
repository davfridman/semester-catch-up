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

// ---------- Views ----------
function planScreen() {
  const m = planModel(), ids = planIDs(), plan = planItems(), open = plan.filter(i => !isHandled(i)).length;
  const btn = (attrs, label, text) => `<button class="round" style="width:32px;height:32px;font-size:14px" ${attrs} aria-label="${label}" title="${label}">${text}</button>`;
  // The number, with ⋯ (move to a slot, take out, remove) under it; ↑ ↓ on the right.
  const num = id => `<span class="pnum"><b>${ids.indexOf(id) + 1}</b><button data-cardmenu="${esc(id)}" aria-label="More" title="Move to a slot, take out, remove">⋯</button></span>`;
  const cardRow = (it, list, k) => `<div style="display:flex;gap:6px;align-items:center">${num(it.id)}<div style="flex:1;min-width:0">${card(it, { showPlanTag: false })}</div>
    <div style="display:grid;gap:2px">${btn(`data-pmove="${esc(it.id)}" data-dir="-1" ${k === 0 ? 'disabled' : ''}`, 'Move up', '↑')}${btn(`data-pmove="${esc(it.id)}" data-dir="1" ${k === list.length - 1 ? 'disabled' : ''}`, 'Move down', '↓')}</div></div>`;
  const bar = its => { const cs = [...new Set(its.map(i => i.c))];
    return `<div class="slot-bar">${cs.map(c => { const mine = its.filter(i => i.c === c), d = mine.filter(isHandled).length;
      return `<span style="flex:${mine.length};background:color-mix(in srgb, ${color(c)} 25%, transparent)" title="${esc(short(course(c)))}: ${d} of ${mine.length} done"><i style="width:${d / mine.length * 100}%;background:${color(c)}"></i></span>`; }).join('')}</div>`; };
  const rows = m.entries.map((e, k) => {
    if (!isSlot(e)) { const it = item(e); return it.hidden ? '' : cardRow(it, m.entries, k); }
    const sl = m.slots[e], its = sl.items.map(item).filter(i => i && !i.hidden), done = its.filter(isHandled).length;
    return `<div class="slot"><div class="slot-head"><button class="grow slot-fold" data-slotfold="${esc(e)}" aria-expanded="${!sl.collapsed}"><span class="chev ${sl.collapsed ? '' : 'open'}"></span><span><b>${esc(sl.name)}</b><small>${its.length ? done === its.length ? `All ${its.length} done` : `${done} of ${its.length} done` : 'Empty'}</small></span></button>
      ${btn(`data-pmove="${esc(e)}" data-dir="-1" ${k === 0 ? 'disabled' : ''}`, 'Move slot up', '↑')}${btn(`data-pmove="${esc(e)}" data-dir="1" ${k === m.entries.length - 1 ? 'disabled' : ''}`, 'Move slot down', '↓')}${btn(`data-slotmenu="${esc(e)}"`, `${esc(sl.name)} options`, '⋯')}</div>
      ${its.length ? bar(its) : ''}${sl.collapsed ? '' : its.length ? `<div class="cards">${its.map((it, j) => cardRow(it, its, j)).join('')}</div>` : '<div style="color:var(--label2);font-size:15px;margin-top:8px">Move cards here with ⋯ on a card.</div>'}</div>`;
  }).join('');
  return `<button class="back" data-back>‹ Overview</button><div class="head"><div><div class="sub">${plan.length ? `${open} to go${plan.length - open ? ` · ${plan.length - open} done` : ''}` : 'Your order of work'}</div><h2>Plan</h2></div>
  <div class="hbtns">${plan.length > open ? '<button class="pill" data-cleardone>Clear done</button>' : ''}<button class="pill" data-addslot>+ Slot</button></div></div>
  ${m.entries.length ? `<div class="cards">${rows}</div>`
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
