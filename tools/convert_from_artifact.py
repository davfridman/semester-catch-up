#!/usr/bin/env python3
"""Convert the old Claude artifact's database export into the app's documents.

Usage: convert_from_artifact.py STATE_DIR OUT.json
STATE_DIR holds courses/, tasks/, sessions/ and settings/ as exported with ArtifactData (out_dir).
Weekly meetings become one item per lecture or tutorial; saved progress (watched, skipped, links, notes) carries over.
"""
import datetime as dt, json, os, sys

SHORT = {'m-2823': 'CMP', 'm-6441': 'SEC', 'm-5542': 'ML', 'm-2830': 'NET', 'm-3669': 'DIST', 'm-6667': 'AGT', 'm-5066': 'INNO', 'm-3922': 'DDI'}


def load(d):
    out = {}
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith('.json'):
                out[f[:-5]] = json.load(open(os.path.join(d, f)))
    return out


def jsday(date):
    return (date.weekday() + 1) % 7


def main(state, dst):
    courses = load(os.path.join(state, 'courses'))
    tasks = load(os.path.join(state, 'tasks'))
    sessions = load(os.path.join(state, 'sessions'))
    prefs = load(os.path.join(state, 'settings')).get('prefs', {})
    out_courses, items = [], []
    for cid, c in sorted(courses.items(), key=lambda kv: kv[1].get('order', 99)):
        out_courses.append({'id': cid, 'name': c['name'], 'code': c.get('code', ''), 'short': SHORT.get(cid, (c.get('code') or cid)[:4].upper()),
                            'moodle': c.get('moodle', ''), 'recordings': c.get('panopto', ''), 'notes': c.get('notes', ''),
                            'grading': c.get('grading', []), 'meetings': c.get('meetings', []), 'start': c.get('start', ''), 'end': c.get('end', ''),
                            'order': c.get('order', 99)})
        # lectures and tutorials from the weekly schedule
        if c.get('start') and c.get('end'):
            d, end = dt.date.fromisoformat(c['start']), dt.date.fromisoformat(c['end'])
            skips = set(c.get('skips') or [])
            while d <= end:
                ds = d.isoformat()
                if ds not in skips:
                    for m in c.get('meetings', []):
                        if int(m['day']) == jsday(d):
                            key = f'{cid}__{ds}__{m["id"]}'
                            o = sessions.get(key, {})
                            items.append({'id': key, 'c': cid, 'type': m.get('type', 'Lecture'), 'date': ds, 'time': m.get('time', ''), 'duration': m.get('duration', 0),
                                          'opens': '', 'weight': None, 'status': {'watched': 'done', 'skip': 'skip', 'cancelled': 'skip'}.get(o.get('status'), 'todo'),
                                          'topic': o.get('topic', ''), 'link': o.get('link', ''), 'note': o.get('note', ''), 'meetingId': m['id']})
                d += dt.timedelta(days=1)
    # sessions outside the weekly schedule (online units, extra recordings)
    for sid, s in sessions.items():
        if s.get('extra'):
            items.append({'id': sid, 'c': s['courseId'], 'type': s.get('type', 'Lecture'), 'date': s['date'], 'time': s.get('time', ''), 'duration': s.get('duration', 0),
                          'opens': '', 'weight': None, 'status': {'watched': 'done', 'skip': 'skip', 'cancelled': 'skip'}.get(s.get('status'), 'todo'),
                          'topic': s.get('topic', ''), 'link': s.get('link', ''), 'note': s.get('note', ''), 'title': s.get('topic') if s.get('type') == 'Online unit' else None})
    for tid, t in tasks.items():
        date = t.get('due') or t.get('opens')
        if not date:
            continue
        items.append({'id': tid, 'c': t['courseId'], 'type': t.get('kind', 'Exercise'), 'title': t['title'], 'date': date, 'time': t.get('dueTime', ''),
                      'opens': t.get('opens', ''), 'opensTime': t.get('opensTime', ''), 'weight': t.get('weight'), 'estimate': t.get('estimate'),
                      'status': {'done': 'done', 'skip': 'skip'}.get(t.get('status'), 'todo'), 'link': t.get('link', ''), 'note': t.get('note', ''),
                      'source': t.get('source', '')})
    # number each type per course in date order: Lecture 1, Lecture 2, Ex 1 ...
    items.sort(key=lambda it: (it['date'], it.get('time') or ''))
    counter = {}
    for it in items:
        k = (it['c'], it['type'])
        counter[k] = counter.get(k, 0) + 1
        it['n'] = counter[k]
        if not it.get('title'):
            it['title'] = f"{it['type']} {it['n']}"
    out = {'courses': out_courses, 'items': items, 'prefs': {k: prefs[k] for k in ('semStart', 'semEnd') if k in prefs}}
    json.dump(out, open(dst, 'w'), ensure_ascii=False, indent=1)
    print(f'{len(out_courses)} courses, {len(items)} items -> {dst}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
