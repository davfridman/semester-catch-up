#!/usr/bin/env python3
"""Builds a student's semester from Moodle and the HUJI Shnaton, with nothing typed by hand.

Usage: semester_setup.py [--dry-run] [--as-new] [--self-test]
  --dry-run    print what would be added, write nothing
  --as-new     ignore what the account already has and show the whole semester it would build (never writes)
  --self-test  check the builder on made-up data (no network, no account)

For every course the student is enrolled in on Moodle that the app doesn't have yet, it adds:
  - the course (name, code, short name, Moodle link, every lecture and tutorial group from the Shnaton);
  - the student's own weekly slots: Moodle knows which groups they registered to ("67521-03-שעור", "67521-11-תרגיל"),
    and the Shnaton knows each group's day and hours;
  - one item per lecture and tutorial for the whole semester, skipping HUJI's no-class days;
  - the exams (final Moed A and B, midterms) with dates, hours and rooms.
A new account also gets the semester's dates and no-class days. Tasks, quizzes and announcements then come from the
regular sync (moodle_sync.py).

It only ever adds. A course the app already has is left exactly as it is, so running it again changes nothing, and a
course joined mid-semester appears on the next run. Only reads from HUJI. Credentials as in supabase_load.py.
"""
import argparse, datetime as dt, html, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from supabase_load import req, user_id, load_cfg  # noqa: E402

NOW = dt.datetime.now().astimezone().isoformat(timespec='seconds')
STAMP = re.sub(r'\D', '', NOW[:19])

# HUJI's academic calendar, by the Shnaton's year and semester (period 1 = A, 2 = B): teaching dates and no-class days.
CALENDARS = {
    (2027, 1): {'start': '2026-10-11', 'end': '2027-01-15', 'breaks': [
        {'from': '2026-10-27', 'to': '2026-10-27', 'label': 'Election day, no classes'},
        {'from': '2026-12-06', 'to': '2026-12-12', 'label': 'Winter break (Hanukkah), no classes'},
        {'from': '2026-12-25', 'to': '2026-12-25', 'label': 'Christmas break, no classes'},
    ]},
}

# A Moodle group named "67521-03-שעור-…" is lecture group 3 of course 67521.
GROUP_NAME = re.compile(r'^\s*(\d{4,6})-(\d{1,3})-(שעור|שיעור|תרגיל|תרגול|מעבדה)')
KIND = {'שעור': 'Lecture', 'שיעור': 'Lecture', 'תרגיל': 'Tutorial', 'תרגול': 'Tutorial', 'מעבדה': 'Lab'}
STOP = {'introduction', 'intro', 'to', 'of', 'and', 'in', 'the', 'for', 'a', 'an', 'with', 'on', '&'}


def registered(group_names):
    """Moodle group names -> [(type, group number)], e.g. [('Lecture', '3'), ('Tutorial', '11')]."""
    out = []
    for name in group_names:
        m = GROUP_NAME.match(name or '')
        if m and (KIND[m.group(3)], str(int(m.group(2)))) not in out:
            out.append((KIND[m.group(3)], str(int(m.group(2)))))
    return out


def names(fullname):
    """'67521_1 - {mlang he}מודלים{mlang}{mlang en}Models{mlang}' -> ('Models', 'מודלים'); plain names fill both.
    Moodle's HTML entities ("&amp;") come out as the characters."""
    rest = re.sub(r'^\s*[\d_]+\s*-\s*', '', html.unescape(fullname or '')).strip()
    en = re.search(r'\{mlang en\}(.*?)\{mlang\}', rest, re.S)
    he = re.search(r'\{mlang he\}(.*?)\{mlang\}', rest, re.S)
    plain = re.sub(r'\{mlang[^}]*\}', '', rest).strip()
    clean = lambda s: re.sub(r'\s+', ' ', s).strip()
    return clean(en.group(1)) if en else clean(plain), clean(he.group(1)) if he else clean(plain)


def short_name(name, taken):
    """A short tag for cards: the initials of the name's main words ("Reliability of Distributed Systems" -> "RDS")."""
    words = [w for w in re.findall(r"[A-Za-z0-9א-ת]+", name) if w.lower() not in STOP and not w.isdigit()]
    tag = (''.join(w[0] for w in words[:4]) if len(words) > 1 else (words[0][:4] if words else 'CRS')).upper()
    base, n = tag, 2
    while tag in taken:
        tag = f'{base}{n}'; n += 1
    return tag


def minutes(start, end):
    if not start or not end:
        return 90
    a, b = (dt.datetime.strptime(x, '%H:%M') for x in (start, end))
    return max(15, int((b - a).total_seconds() // 60))


def meetings_for(mine, shnaton_groups):
    """The student's weekly slots: the Shnaton sessions of the groups they registered to.
    -> [{id: 'L1', type, day, time, duration, group}]. A lab is tracked like a tutorial (something you attend)."""
    letter = {'Lecture': 'L', 'Tutorial': 'T', 'Lab': 'B'}
    clock = lambda t: dt.datetime.strptime(t, '%H:%M')
    out, count = [], {}
    for typ, num in mine:
        slots = []  # [day, start, end]
        for g in sorted((g for g in shnaton_groups if g['type'] == typ and g['group'] == num), key=lambda g: (g['day'], g['time'])):
            end = g.get('end') or (clock(g['time']) + dt.timedelta(minutes=90)).strftime('%H:%M')
            last = slots[-1] if slots else None
            if last and last[0] == g['day'] and clock(g['time']) <= clock(last[2]) + dt.timedelta(minutes=30):
                # The same session listed twice, or its second part after a short break: one lecture, not two.
                last[2] = max(last[2], end)
                continue
            slots.append([g['day'], g['time'], end])
        for day, start, end in slots:
            count[typ] = count.get(typ, 0) + 1
            out.append({'id': f'{letter[typ]}{count[typ]}', 'type': 'Tutorial' if typ == 'Lab' else typ, 'day': day, 'time': start,
                        'duration': minutes(start, end), 'group': num, 'lab': typ == 'Lab'})
    return out


def session_items(cid, meetings, cal):
    """One item per lecture and tutorial from the semester's first day to its last, skipping no-class days."""
    start, end = dt.date.fromisoformat(cal['start']), dt.date.fromisoformat(cal['end'])
    off = lambda d: any(b['from'] <= d <= b['to'] for b in cal.get('breaks') or [])
    dated = []
    day = start
    while day <= end:
        iso = day.isoformat()
        if not off(iso):
            for m in meetings:
                if (day.weekday() + 1) % 7 == m['day']:  # 0 = Sunday, as the Shnaton and the app count
                    dated.append((iso, m['time'], m))
        day += dt.timedelta(days=1)
    out, n = [], {}
    for iso, time_, m in sorted(dated, key=lambda x: (x[0], x[1], x[2]['id'])):
        label = 'Lab' if m.get('lab') else m['type']
        n[label] = n.get(label, 0) + 1
        out.append({'c': cid, 'n': n[label], 'id': f'{cid}__{iso}__{m["id"]}', 'date': iso, 'link': '', 'note': '', 'time': time_, 'type': m['type'],
                    'opens': '', 'title': f'{label} {n[label]}', 'topic': '', 'status': 'todo', 'weight': None, 'duration': m['duration'],
                    'meetingId': m['id']})
    return out


def exam_items(cid, code, found, today, write_note):
    """The Shnaton's exams as items: the final's Moed A and B each get one (B is optional), midterms keep B in the note."""
    num, link, out = cid.split('-', 1)[-1], f'https://shnaton.huji.ac.il/course/{code}', []

    def item(iid, n, title, s, note, **extra):
        it = {'c': cid, 'n': n, 'id': iid, 'date': s['date'], 'link': link, 'note': note, 'time': s['time'], 'type': 'Exam', 'opens': '',
              'opensTime': '', 'title': title, 'source': 'shnaton', 'status': 'todo', 'weight': None}
        if s.get('end'):
            it['endTime'] = s['end']
        if s.get('rooms'):
            it['rooms'] = s['rooms']
        it.update(extra)
        return it

    for key, (a, b) in sorted(found.items()):
        if max(a['date'], b['date'] if b else '') < today:
            continue  # over already
        if key == 'final':
            out.append(item(f'x-{num}-final', 1, 'Final exam · Moed A', a, write_note('', a, False)))
            if b:
                out.append(item(f'x-{num}-final-b', 2, 'Final exam · Moed B', b,
                                write_note('Optional second exam date (Moed B): take it if you miss Moed A or want another try.', b, False), optional=True))
        else:
            i = int(key[1:])
            extra = {'secondDate': b['date'], 'secondTime': b['time']} if b else {}
            out.append(item(f'x-{num}-{key}', i, f'Midterm {i}', a, write_note('', a, b), **extra))
    return out


def build(enrolled, courses, items, prefs, cal, today, write_note):
    """What to add for one student. Pure: everything it needs comes in.
    enrolled: [{'id': Moodle course id, 'idnumber', 'fullname', 'groups': [Moodle group names],
                'shnaton': [groups()], 'exams': exams(), 'otherSemester': 'B' when only the other semester teaches it}]
    A course the Shnaton gives no hours in either semester is an online course: it's added without lectures, and its
    tasks come from the sync. One taught only in the other semester waits for that semester.
    -> (new courses, new items, prefs to add, summary lines)"""
    have_moodle, have_code = set(), set()
    for c in courses.values():
        m = re.search(r'[?&]id=(\d+)', c.get('moodle') or '')
        if m:
            have_moodle.add(m.group(1))
        if c.get('code'):
            have_code.add(str(c['code']).split('_')[0])
    taken = {c.get('short') for c in courses.values()}
    order = max([c.get('order') or 0 for c in courses.values()] or [0])
    new_courses, new_items, summary = [], [], []
    for e in sorted(enrolled, key=lambda e: str(e.get('idnumber') or e['id'])):
        mid, code = str(e['id']), str(e.get('idnumber') or '').split('_')[0]
        cid = f'm-{mid}'
        if mid in have_moodle or cid in courses or (code and code in have_code):
            continue
        en, he = names(e.get('fullname'))
        name = en or he
        mine = registered(e.get('groups') or [])
        groups = e.get('shnaton') or []
        if not code:
            summary.append(f'  Skipped {name}: not a course in the Shnaton.')
            continue
        if not groups and e.get('otherSemester'):
            summary.append(f'  {name}: taught in semester {e["otherSemester"]}, so it\'s added when that semester starts.')
            continue
        online = not groups
        meetings = meetings_for(mine, groups)
        short = short_name(name, taken); taken.add(short)
        order += 1
        course = {'id': cid, 'name': name, 'code': code, 'short': short, 'order': order, 'start': cal['start'], 'end': cal['end'],
                  'moodle': f'{e["site"]}/course/view.php?id={mid}', 'recordings': '', 'notes': '', 'grading': [], 'profile': {},
                  'meetings': [{k: m[k] for k in ('id', 'day', 'time', 'type', 'duration')} for m in meetings],
                  'classGroups': [g for g in groups if g['type'] in ('Lecture', 'Tutorial')]}
        if he and he != name:
            course['nameHe'] = he
        sessions = session_items(cid, meetings, cal)
        exams = exam_items(cid, code, e.get('exams') or {}, today, write_note)
        new_courses.append(course)
        new_items += sessions + exams
        lectures = sum(1 for s in sessions if s['type'] == 'Lecture')
        parts = [f'{lectures} lectures'] if lectures else []
        if len(sessions) - lectures:
            parts.append(f'{len(sessions) - lectures} tutorials')
        if exams:
            parts.append(f'{len(exams)} exam dates')
        summary.append(f'+ {short}: {name}' + (' (' + ', '.join(parts) + ')' if parts else ''))
        if online:
            summary.append(f'  {short}: an online course with no weekly hours, so it has no lectures; its tasks come from Moodle.')
        elif mine and not meetings:
            summary.append(f'! {short}: your groups have no weekly hours in the Shnaton, so no lectures were added. Set the day and time on the course page.')
        if not mine and groups:
            summary.append(f'! {short}: Moodle doesn\'t say which group you\'re in. Pick your lecture and tutorial on the course page.')
    add_prefs = {}
    if new_courses and not prefs.get('semStart'):
        add_prefs = {'semStart': cal['start'], 'semEnd': cal['end'], 'breaks': cal['breaks']}
    return new_courses, new_items, add_prefs, summary


def gather(token, year, period, have_moodle_ids=()):
    """The student's Moodle enrolments with their groups, plus each course's Shnaton groups and exams. Courses the
    app already has (`have_moodle_ids`) are listed but not looked up, so an hourly run for a student whose semester
    is built costs one Moodle call."""
    import moodle_api as m
    import shnaton as s
    m.ALLOWED.add('core_group_get_course_user_groups')
    me = m.ws(token, 'core_webservice_get_site_info')['userid']
    out = []
    for c in m.ws(token, 'core_enrol_get_users_courses', userid=me):
        e = {'id': c['id'], 'idnumber': c.get('idnumber') or '', 'fullname': c.get('fullname') or '', 'site': m.SITE, 'groups': [], 'shnaton': [], 'exams': {}}
        out.append(e)
        if str(c['id']) in have_moodle_ids:
            continue
        print(f'  looking up {names(e["fullname"])[0]}', flush=True)
        try:
            e['groups'] = [g.get('name') or '' for g in m.ws(token, 'core_group_get_course_user_groups', courseid=c['id'], userid=me).get('groups', [])]
        except RuntimeError:
            pass
        code = str(e['idnumber']).split('_')[0]
        if code.isdigit():
            try:
                e['shnaton'] = s.groups(code, year, period, labs=True)
                e['exams'] = s.exams(code, year, period)
                if not e['shnaton'] and s.groups(code, year, 3 - period, labs=True):
                    e['otherSemester'] = 'AB'[2 - period]
            except Exception as err:  # the Shnaton didn't answer: leave this course for the next run
                e['failed'] = str(err)
    return out


def self_test():
    cal = CALENDARS[(2027, 1)]
    note = lambda old, a, b: (old + ' ' if old else '') + (f'Time: {a["time"]}.' if a['time'] else '')
    g = lambda typ, num, day, t, end: {'type': typ, 'group': num, 'day': day, 'time': t, 'end': end, 'room': 'R', 'teacher': 'T'}
    enrolled = [
        {'id': 10, 'idnumber': '67521_1', 'site': 'https://m', 'fullname': '67521_1 - {mlang he}מודלים חישוביים{mlang}{mlang en}Computational Models, Computability and Complexity{mlang}',
         'groups': ['67521-03-שעור-67521_1 - x', '67521-11-תרגיל-67521_1 - x', 'Thu 14:00 (A105)'],
         'shnaton': [g('Lecture', '3', 1, '10:00', '11:45'), g('Lecture', '3', 3, '10:00', '10:45'), g('Lecture', '1', 0, '11:00', '13:45'),
                     g('Tutorial', '11', 2, '16:00', '17:45'), g('Tutorial', '11', 2, '16:00', '17:45')],
         'exams': {'final': ({'date': '2027-02-01', 'time': '09:00', 'end': '12:00', 'rooms': ['A']}, {'date': '2027-03-01', 'time': '', 'end': '', 'rooms': []}),
                   'q1': ({'date': '2026-10-20', 'time': '18:00', 'end': '', 'rooms': []}, None),
                   'q2': ({'date': '2026-12-20', 'time': '18:00', 'end': '', 'rooms': []}, None)}},
        {'id': 11, 'idnumber': '67594', 'site': 'https://m', 'fullname': '67594 - Introduction to Communication Networks', 'groups': [],
         'shnaton': [g('Lecture', '1', 0, '14:00', '15:45')], 'exams': {}},
        {'id': 14, 'idnumber': '67519', 'site': 'https://m', 'fullname': '67519 - Reliability of Distributed Systems 101', 'groups': ['67519-01-שעור'],
         'shnaton': [g('Lecture', '1', 4, '12:00', '13:45'), g('Lecture', '1', 4, '14:00', '14:45')], 'exams': {}},
        {'id': 12, 'idnumber': '', 'site': 'https://m', 'fullname': 'Library guide', 'groups': [], 'shnaton': [], 'exams': {}},
        {'id': 13, 'idnumber': '67577', 'site': 'https://m', 'fullname': '67577 - Machine Learning', 'groups': ['67577-01-שעור'], 'shnaton': [], 'exams': {}},
        {'id': 15, 'idnumber': '76408', 'site': 'https://m', 'fullname': '76408 - {mlang he}ספרייה{mlang}{mlang en}Library Resources &amp; Skills{mlang}',
         'groups': [], 'shnaton': [], 'exams': {}},
        {'id': 16, 'idnumber': '57108_1', 'site': 'https://m', 'fullname': '57108_1 - Introduction to Economics II', 'groups': ['57108-01-שעור'],
         'shnaton': [], 'exams': {}, 'otherSemester': 'B'},
    ]
    have = {'m-13': {'id': 'm-13', 'short': 'ML', 'code': '67577', 'order': 4, 'moodle': 'https://m/course/view.php?id=13'}}
    cs, its, prefs, summary = build(enrolled, have, {}, {}, cal, '2026-11-10', note)
    assert [c['id'] for c in cs] == ['m-14', 'm-10', 'm-11', 'm-15'], [c['id'] for c in cs]
    dist, comp, net, online = cs
    assert online['name'] == 'Library Resources & Skills' and online['meetings'] == [] and not [i for i in its if i['c'] == 'm-15'], online  # online: no lectures, tasks come from the sync
    assert dist['short'] == 'RDS' and dist['meetings'] == [{'id': 'L1', 'day': 4, 'time': '12:00', 'type': 'Lecture', 'duration': 165}], dist
    assert comp['name'] == 'Computational Models, Computability and Complexity' and comp['nameHe'] == 'מודלים חישוביים' and comp['code'] == '67521'
    assert comp['short'] == 'CMCC' and net['short'] == 'CN' and (comp['order'], net['order']) == (6, 7), (comp['short'], net['short'])
    assert comp['meetings'] == [{'id': 'L1', 'day': 1, 'time': '10:00', 'type': 'Lecture', 'duration': 105},
                                {'id': 'L2', 'day': 3, 'time': '10:00', 'type': 'Lecture', 'duration': 45},
                                {'id': 'T1', 'day': 2, 'time': '16:00', 'type': 'Tutorial', 'duration': 105}], comp['meetings']
    assert net['meetings'] == []  # no registered group: the student picks one in the app
    mine = [i for i in its if i['c'] == 'm-10']
    lectures = [i for i in mine if i['type'] == 'Lecture']
    assert lectures[0]['id'] == 'm-10__2026-10-12__L1' and lectures[0]['title'] == 'Lecture 1' and lectures[1]['id'] == 'm-10__2026-10-14__L2'
    assert [i['n'] for i in lectures] == list(range(1, len(lectures) + 1))
    days = {i['date'] for i in mine if i['type'] != 'Exam'}
    assert '2026-10-27' not in days and not any('2026-12-06' <= d <= '2026-12-12' for d in days) and max(days) <= '2027-01-15'
    exams = {i['id']: i for i in mine if i['type'] == 'Exam'}
    assert set(exams) == {'x-10-final', 'x-10-final-b', 'x-10-q2'}, set(exams)  # q1 is over
    assert exams['x-10-final-b']['optional'] is True and exams['x-10-final']['rooms'] == ['A'] and exams['x-10-q2']['title'] == 'Midterm 2'
    assert prefs == {'semStart': cal['start'], 'semEnd': cal['end'], 'breaks': cal['breaks']}
    assert any('Pick your lecture' in l for l in summary) and any('semester B' in l for l in summary)
    assert not any(l.startswith('!') and ('Library guide' in l or 'Economics' in l or 'online' in l) for l in summary), summary  # no daily warnings
    again = dict(have, **{c['id']: c for c in cs})
    assert build(enrolled, again, {}, {'semStart': 'x'}, cal, '2026-11-10', note)[:3] == ([], [], {})  # running again adds nothing
    print(f'Semester setup: self-test ok ({len(its)} items for {len(cs)} courses)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--as-new', action='store_true')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    import moodle_api as m
    import shnaton as s
    cfg = load_cfg()
    uid = user_id(cfg)
    base = cfg['url'] + '/rest/v1/docs'
    rows = req('GET', f'{base}?user_id=eq.{uid}&select=col,id,data&limit=10000', cfg['service_key'])
    token = os.environ.get('MOODLE_TOKEN') or next(((r['data'] or {}).get('token') for r in rows if r['col'] == 'settings' and r['id'] == 'moodle'), None)
    if not token:
        print('Semester setup: Moodle is not connected yet.')
        return
    courses = {} if a.as_new else {r['id']: r['data'] for r in rows if r['col'] == 'course'}
    items = {} if a.as_new else {r['id']: r['data'] for r in rows if r['col'] == 'item'}
    prefs = {} if a.as_new else (next((r['data'] for r in rows if r['col'] == 'settings' and r['id'] == 'prefs'), {}) or {})
    try:
        year = next(y['year'] for y in s.get('/reference-data/active-years') if y.get('current'))
    except Exception:
        year = s.TODAY.year + 1 if s.TODAY.month >= 8 else s.TODAY.year
    period = 1 if s.TODAY.month >= 8 or s.TODAY.month <= 3 else 2
    cal = CALENDARS.get((year, period))
    if not cal:
        print(f"Semester setup: HUJI's calendar for {year}, semester {'AB'[period - 1]} isn't in this tool yet, so nothing was added.")
        return
    try:
        have = set()
        for c in courses.values():
            mm = re.search(r'[?&]id=(\d+)', c.get('moodle') or '')
            if mm:
                have.add(mm.group(1))
        enrolled = gather(token, year, period, have)
    except m.TokenError:
        print('Semester setup: the Moodle connection has expired. Reconnect Moodle in the app.')
        return
    # A course the Shnaton didn't answer for waits for the next run instead of being added half-built.
    waiting = [e for e in enrolled if e.get('failed')]
    enrolled = [e for e in enrolled if not e.get('failed')]
    new_courses, new_items, add_prefs, summary = build(enrolled, courses, items, prefs, cal, s.TODAY.isoformat(), s.write_note)
    new_items = [i for i in new_items if i['id'] not in items]
    dry = a.dry_run or a.as_new
    if not dry and (new_courses or add_prefs):
        out = [{'user_id': uid, 'col': 'course', 'id': c['id'], 'data': c} for c in new_courses]
        out += [{'user_id': uid, 'col': 'item', 'id': i['id'], 'data': i} for i in new_items]
        for c in new_courses:
            line = next((l[2:] for l in summary if l.startswith(f'+ {c["short"]}:')), c['name'])
            u = {'id': f'u-{STAMP}-{c["id"]}', 'kind': 'new', 'text': 'Added ' + line, 'course': c['id'], 'at': NOW, 'seen': False, 'source': 'setup'}
            out.append({'user_id': uid, 'col': 'update', 'id': u['id'], 'data': u})
        if add_prefs:  # read the settings again just before writing, so nothing set meanwhile is lost
            fresh = next((r['data'] for r in req('GET', f'{base}?user_id=eq.{uid}&col=eq.settings&id=eq.prefs&select=data', cfg['service_key'])), {}) or {}
            out.append({'user_id': uid, 'col': 'settings', 'id': 'prefs', 'data': dict(add_prefs, **fresh)})
        for i in range(0, len(out), 300):
            req('POST', base + '?on_conflict=user_id,col,id', cfg['service_key'], out[i:i + 300], {'Prefer': 'resolution=merge-duplicates,return=minimal'})
    print(f'Semester setup: {len(new_courses)} courses and {len(new_items)} items to add' + (' (dry run, nothing written)' if dry else ''))
    for line in summary:
        print(line)
    for e in waiting:
        print(f"! The Shnaton didn't answer for {names(e['fullname'])[0]}; it will be added on the next run.")
    if a.as_new:
        for c in new_courses:
            print(f'  {c["short"]} meetings: ' + ', '.join(f'{m_["id"]} {"SMTWTFS"[m_["day"]]}{m_["day"]} {m_["time"]} {m_["duration"]}m' for m_ in c['meetings']))


if __name__ == '__main__':
    main()
