// Shared rendering helpers (the design system): escaping, formats, icons, rings, the task card, the feed card,
// segmented controls, the theme and toasts. They return HTML or touch only the page, never the data.
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Formats ----------
function ago(t) {
  const d = new Date(t); if (isNaN(d)) return '';
  const m = Math.max(0, (Date.now() - d) / 6e4);
  if (m < 1) return 'just now'; if (m < 60) return `${Math.floor(m)} min ago`;
  const h = m / 60; if (h < 24) { const n = Math.round(h); return n === 1 ? '1 hour ago' : `${n} hours ago`; }
  const n = Math.round(h / 24); return n === 1 ? 'yesterday' : `${n} days ago`;
}
const longDate = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const fmt = v => (v === Math.round(v) ? String(v) : v.toFixed(1));
const isRTL = s => { let r = 0, l = 0; for (const ch of String(s || '')) { if (/[֐-ࣿיִ-﷿]/.test(ch)) r++; else if (/\p{L}/u.test(ch)) l++; } return r > l; };
const seconds = s => String(s || '').split(':').map(Number).filter(n => !isNaN(n)).reduce((a, b) => a * 60 + b, 0);
const clock = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };

// ---------- Icons and rings ----------
const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ROW_ICONS = {
  cap: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>'),
  play: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>'),
  megaphone: svg('<path d="M3 10v4h4l8 4V6L7 10z"/><path d="M18 9a4 4 0 010 6"/>'),
  doc: svg('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  note: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
};
const ICONS = {
  courses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="4" width="4" height="16" rx="1"/><rect x="9.5" y="4" width="4" height="16" rx="1"/><path d="M15.6 5.2l3.8-1 3.1 15.4-3.8 1z"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="13" r="8"/><path d="M12 13l4-4" stroke-linecap="round"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><text x="2.5" y="8" font-size="6" fill="currentColor" stroke="none">1</text><text x="2.5" y="14" font-size="6" fill="currentColor" stroke="none">2</text><text x="2.5" y="20" font-size="6" fill="currentColor" stroke="none">3</text></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
};
function ring(fraction, size, width, col) {
  const r = (size - width) / 2, c = 2 * Math.PI * r, f = fraction ?? 0;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--fill2)" stroke-width="${width}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
const ringWithText = (fraction, size, width, col, text, fs) => `<div style="position:relative;width:${size}px;height:${size}px">${ring(fraction, size, width, col)}<div style="position:absolute;inset:0;display:grid;place-items:center;font-size:${fs}px;font-weight:700">${esc(text)}</div></div>`;
const CIRCLE = { todo: ['', ''], due: ['', ''], watch: ['', ''], open: ['', 'locked'], done: ['✓', 'filled'], reviewed: ['~', 'filled'], wont: ['✕', ''], closed: ['!', 'filled'] };

// ---------- Cards and controls ----------
/// A card: title and one time cue, then a quiet line of tags and the course (DESIGN.md, Card anatomy).
function card(it, { trailing = 'date', showCourse = true, showPlanTag = true, title } = {}) {
  const st = state(it), key = st.key, open = ['todo', 'due', 'watch'].includes(key);
  const col = key === 'open' ? 'var(--label3)' : key === 'closed' || key === 'wont' ? 'var(--red)' : color(it.c);
  const [g, cls] = inProgress(it) && open ? ['◐', ''] : CIRCLE[key] || ['', ''];
  let cue, strong = false;
  if (trailing === 'time') cue = it.time || 'All day';
  else if (key === 'open') cue = st.text;
  else if (!open) cue = st.text;
  else if (isSession(it)) { const n = parse(it.date) ? daysBetween(parse(it.date), new Date()) : 0; cue = n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days behind`; }
  else { const n = parse(it.date) ? daysBetween(new Date(), parse(it.date)) : 99; cue = n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? dow(it.date) : dm(it.date); strong = n <= 1; }
  const cueColor = !open && key !== 'open' ? (key === 'done' ? 'var(--green)' : key === 'reviewed' ? 'var(--mint)' : 'var(--red)') : '';
  const tags = [];
  if (open && isExam(it)) tags.push('<span class="tag strong">Exam</span>');
  const pi = planIDs().indexOf(it.id);
  if (open && showPlanTag && pi >= 0) tags.push(`<span class="tag" aria-label="Number ${pi + 1} in your plan">≡ ${pi + 1}</span>`);
  const extra = [];
  if (trailing === 'time' || !showCourse) { if (!(open && isExam(it))) extra.push(esc(it.type)); }
  if (it.weight > 0) extra.push(`${fmt(it.weight)}%`);
  if (it.grade != null && isHandled(it)) extra.push(`grade ${fmt(it.grade)}`);
  const c = course(it.c);
  const ctx = (showCourse && c ? `<span style="color:${color(it.c)}">${esc(displayName(c))}</span>${extra.length ? ' · ' : ''}` : '') + extra.join(' · ');
  const watched = Math.floor(seconds(it.stopAt) / 60), dur = it.duration || 90;
  const progress = isSession(it) && it.stopAt && !isHandled(it) ? `<div class="bar"><i style="width:${Math.min(100, watched / dur * 100)}%;background:${color(it.c)}"></i></div>` : '';
  const note = inProgress(it) && it.note ? `<div class="l2" style="font-size:12px">✎ ${esc(it.note.split('\n')[0])}</div>` : '';
  const bg = key === 'done' ? 'done' : key === 'reviewed' ? 'reviewed' : key === 'closed' || key === 'wont' ? 'missed' : '';
  return `<div class="card ${bg}" data-open="${esc(it.id)}" role="button" tabindex="0">
    <button class="circle ${cls}" style="color:${col}" data-toggle="${esc(it.id)}" aria-label="${isHandled(it) ? 'Mark as not done' : isSession(it) ? 'Mark watched' : 'Mark done'}" ${key === 'open' ? 'disabled' : ''}><span>${g}</span></button>
    <div class="cbody"><div class="l1"><div class="title ${open ? '' : 'dim'}" dir="auto">${esc(title || it.title)}</div><div class="cue ${strong ? 'strong' : ''}" style="${cueColor ? `color:${cueColor};font-weight:500` : ''}">${esc(cue)}</div></div>
    <div class="l2">${tags.join('')}<span style="overflow:hidden;text-overflow:ellipsis">${ctx}</span>${hasYourNotes(it) && !note ? '<span class="note-badge" aria-label="Has your note">✎</span>' : ''}</div>${progress}${note}</div></div>`;
}
const cardsOr = (list, empty, opts) => (list.length ? `<div class="cards">${list.map(i => card(i, opts)).join('')}</div>` : `<div class="empty">${esc(empty)}</div>`);
const seg = (name, options, current) => `<div class="seg" role="tablist">${options.map(([v, l]) => `<button role="tab" class="${v === current ? 'on' : ''}" data-seg="${name}" data-val="${v}">${esc(l)}</button>`).join('')}</div>`;
/// One update or insight from the feed (the Overview's top card and the updates screen).
function feedCard(c, stacked = false) {
  const co = course(c.course);
  return `<div class="fcard" data-card="${esc(c.id)}" role="button" tabindex="0"><div class="lab"><span>${c.sym}</span>${esc(c.label)}${c.at ? ` · ${esc(ago(c.at))}` : ''}</div>
    <div class="txt" dir="auto" style="display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden">${esc(c.text)}</div>${c.detail ? `<div class="det" dir="auto">${esc(c.detail)}</div>` : ''}
    <div class="foot"><span style="color:${color(c.course)}">${co ? esc(displayName(co)) : ''}</span><button class="pill" data-seen="${esc(c.id)}">Seen</button></div>${stacked ? '<div class="stack-shadow"></div>' : ''}</div>`;
}

// ---------- Theme and toasts ----------
function applyTheme() { const a = S.prefs.appearance; if (a === 'light' || a === 'dark') document.documentElement.dataset.theme = a; else delete document.documentElement.dataset.theme; }
let toastTimer;
function toast(msg, undo) {
  clearTimeout(toastTimer); document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
  if (undo) t.querySelector('button').onclick = () => { t.remove(); undo(); };
  document.body.appendChild(t); toastTimer = setTimeout(() => t.remove(), undo ? 5000 : 2400);
}
