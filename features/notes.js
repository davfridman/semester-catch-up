// Your notes: everything you wrote on tasks and lectures, searchable (NotesModel in the iPhone app).
'use strict';

const setNotesQuery = q => { S.notesQuery = q; };

// ---------- Views ----------
// Every note you wrote, by course; tapping one opens its task or lecture. `id` limits it to one course.
function notesScreen(id) {
  const q = (S.notesQuery || '').trim().toLowerCase();
  const its = S.items.filter(i => !i.hidden && hasYourNotes(i) && (!id || i.c === id))
    .filter(i => !q || [i.title, yourNote(i), reflectionNote(i)].some(x => (x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const cs = (id ? [course(id)] : visibleCourses()).filter(c => c && its.some(i => i.c === c.id));
  return `<button class="back" data-back>‹ ${id ? esc(short(course(id))) : 'Overview'}</button><div class="head"><h2>${id ? `${esc(short(course(id)))} notes` : 'Your notes'}</h2></div>
  <input class="search" type="search" placeholder="Search your notes" value="${esc(S.notesQuery || '')}" data-notesq>
  ${its.length ? cs.map(c => `${id ? '' : `<div class="group-title" style="color:${color(c.id)}">${esc(displayName(c))}</div>`}<div class="group">${its.filter(i => i.c === c.id).map(i => `<button class="row note-row" data-open="${esc(i.id)}"><span class="grow"><span class="nt"><b dir="auto">${esc(i.title)}</b><span class="val">${esc(dm(i.date))}</span></span>${yourNote(i) ? `<span class="nb" dir="auto">${esc(yourNote(i))}</span>` : ''}${reflectionNote(i) ? `<span class="nb dim" dir="auto">💬 ${esc(reflectionNote(i))}</span>` : ''}</span></button>`).join('')}</div>`).join('')
    : `<div class="empty">${q ? 'No matches.' : 'No notes yet. Open a task or lecture and write where you left off. Your notes gather here.'}</div>`}`;
}
