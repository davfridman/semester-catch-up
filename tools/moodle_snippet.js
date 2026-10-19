// Run in a signed-in tab on https://moodle.huji.ac.il/2026-27/ (javascript tool, REPL semantics).
// Read-only: it only fetches pages and AJAX data. The last expression is the result as a JSON string.
(async () => {
  const W = M.cfg.wwwroot;
  const call = async (methodname, args) => {
    const r = await fetch(W + '/lib/ajax/service.php?sesskey=' + M.cfg.sesskey, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ index: 0, methodname, args }]) });
    return (await r.json())[0];
  };
  const out = { fetchedAt: new Date().toISOString(), courses: {}, activities: {}, panopto: {}, status: {}, errors: [] };
  const en = await call('core_course_get_enrolled_courses_by_timeline_classification', { offset: 0, limit: 0, classification: 'all', sort: 'fullname' });
  if (en.error) return JSON.stringify({ error: 'not signed in or session expired', detail: String(en.exception && en.exception.message) });
  for (const c of en.data.courses) out.courses[c.id] = c.fullname;
  for (const id of Object.keys(out.courses)) {
    try {
      const html = await (await fetch(W + '/course/view.php?id=' + id)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      out.activities[id] = [...doc.querySelectorAll('li.activity')].map(li => {
        const a = li.querySelector('.activityname a, a.aalink');
        const name = (li.querySelector('.instancename') || {}).textContent;
        const mod = [...li.classList].find(x => x.startsWith('modtype_'));
        const dates = [...li.querySelectorAll('[data-region="activity-dates"] div')].map(d => d.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
        const cmid = a && (a.href.match(/[?&]id=(\d+)/) || [])[1];
        return [mod && mod.slice(8), name && name.replace(/\s+/g, ' ').trim(), cmid || null, dates];
      }).filter(x => x[1] && ['assign', 'quiz'].includes(x[0]));
    } catch (e) { out.errors.push('course ' + id + ': ' + e); }
    try {
      const p = await call('block_panopto_get_content', { courseid: +id });
      if (!p.error) {
        const html = typeof p.data === 'string' ? p.data : (p.data.content || '');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        out.panopto[id] = [...doc.querySelectorAll('a')].map(a => [a.textContent.trim(), (a.href.match(/id=([0-9a-f-]{36})/) || [])[1]]).filter(x => x[1]);
      }
    } catch (e) { out.errors.push('panopto ' + id + ': ' + e); }
  }
  for (const acts of Object.values(out.activities)) for (const [mod, , cmid] of acts) {
    if (!cmid) continue;
    try {
      const html = await (await fetch(W + '/mod/' + mod + '/view.php?id=' + cmid)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const txt = doc.body.innerText || doc.body.textContent || '';
      let st = 'none';
      if (mod === 'assign') { const sub = ((doc.querySelector('.submissionstatustable') || {}).textContent || '').replace(/\s+/g, ' '); if (/Submission status Submitted/i.test(sub) || /Submitted for grading/i.test(sub)) st = 'submitted'; }
      else if (/Your final grade for this quiz is|Finished\s*Submitted/i.test(txt)) st = 'submitted';
      out.status[cmid] = st;
    } catch (e) { out.errors.push('status ' + cmid + ': ' + e); }
  }
  return JSON.stringify(out);
})()
