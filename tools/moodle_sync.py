#!/usr/bin/env python3
"""Daily Moodle sync for the Semester Catch-Up app (Supabase edition).

Usage: moodle_sync.py [--moodle MOODLE.json] [--dry-run]
  --moodle  JSON returned by moodle_snippet.js in a signed-in Moodle tab (activities, Panopto recordings, submissions).
            Without it, only the Moodle calendar feed is used (deadlines and opening dates).
Reads ~/.config/semester-catchup/supabase.local.json ({url, service_key, email}) and the private calendar feed link in
~/.config/semester-catchup/moodle-ics-url. Never changes what the student set: done/skipped status, topics, notes.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from supabase_load import req, user_id, CFG, SSL  # noqa: E402

ICS_URL_FILE = os.path.expanduser('~/.config/semester-catchup/moodle-ics-url')
NOW = dt.datetime.now().astimezone().isoformat(timespec='seconds')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def jsday(d):
    return (d.weekday() + 1) % 7


def parse_moodle_date(s):
    for fmt in ('%d %B %Y %I:%M %p', '%d %B %Y %H:%M'):
        try:
            return dt.datetime.strptime(s.strip(), fmt)
        except ValueError:
            pass
    return None


def activity_dates(text):
    res = {}
    for label, rest in re.findall(r'(Opened|Opens|Due|Closes|Closed|Allow submissions from):\s*([^|]+)', text or ''):
        m = re.search(r'(\d{1,2} \w+ \d{4}),\s*(\d{1,2}:\d{2}(?: [AP]M)?)', rest)
        d = parse_moodle_date(m.group(1) + ' ' + m.group(2)) if m else None
        if d:
            res['opens' if label.startswith(('Open', 'Allow')) else 'due'] = (d.strftime('%Y-%m-%d'), d.strftime('%H:%M'))
    return res


def clean_title(name):
    return re.sub(r'\s+(Assignment|Quiz)$', '', name or '').strip()


def kind_for(mod, title):
    t = title.lower()
    if mod == 'quiz' or 'quiz' in t or 'בוחן' in t:
        return 'Quiz'
    if 'lab' in t:
        return 'Lab'
    if 'exam' in t or 'מבחן' in t:
        return 'Exam'
    return 'Exercise'


def parse_ics(text):
    text = re.sub(r'\r?\n[ \t]', '', text.replace('\r\n', '\n'))
    evs = []
    for block in text.split('BEGIN:VEVENT')[1:]:
        e = {}
        for line in block.split('\n'):
            if ':' in line:
                k, v = line.split(':', 1)
                e[k.split(';')[0]] = v.replace('\\,', ',').replace('\\;', ';').replace('&amp;', '&').strip()
        raw = e.get('DTSTART', '')
        try:
            e['_dt'] = (dt.datetime.strptime(raw, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc).astimezone() if raw.endswith('Z')
                        else dt.datetime.strptime(raw[:15], '%Y%m%dT%H%M%S'))
            evs.append(e)
        except ValueError:
            pass
    return evs


def ics_base(summary):
    s = summary.strip()
    m = re.match(r"^יש להגיש את ['‘’\"](.+?)['‘’\"]\s*$", s)
    if m:
        return m.group(1).strip(), 'due'
    for suffix, kind in ((' is due', 'due'), (' closes', 'due'), (' opens', 'opens'), (' is open', 'opens')):
        if s.lower().endswith(suffix):
            return s[: -len(suffix)].strip(), kind
    return s, 'due'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--moodle')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    cfg = json.load(open(CFG))
    uid = user_id(cfg)
    base = cfg['url'] + '/rest/v1/docs'
    rows = req('GET', f'{base}?user_id=eq.{uid}&select=col,id,data&limit=10000', cfg['service_key'])
    courses = {r['id']: r['data'] for r in rows if r['col'] == 'course'}
    items = {r['id']: r['data'] for r in rows if r['col'] == 'item'}
    by_moodle, by_code = {}, {}
    for cid, c in courses.items():
        m = re.search(r'[?&]id=(\d+)', c.get('moodle') or '')
        if m:
            by_moodle[m.group(1)] = cid
        if c.get('code'):
            by_code[str(c['code']).split('_')[0]] = cid
    changed, summary = {}, []

    def put(it, why):
        cur = items.get(it['id'])
        if cur is not None:
            # Fields the user edited in the app ('locked') keep the user's version.
            for f in cur.get('locked') or []:
                if f in cur:
                    it[f] = cur[f]
                else:
                    it.pop(f, None)
            if it == cur:
                return
        items[it['id']] = it; changed[it['id']] = it; summary.append(why)

    def next_n(cid, typ):
        return 1 + max([x.get('n', 0) for x in items.values() if x['c'] == cid and x['type'] == typ] or [0])

    moodle = json.load(open(a.moodle)) if a.moodle and os.path.exists(a.moodle) else None
    if moodle and moodle.get('error'):
        summary.append('! Moodle sign-in has expired, so only the calendar feed was used. Sign in to Moodle in the Claude app browser.')
        moodle = None
    claimed = set()
    if moodle:
        for mid, name in moodle.get('courses', {}).items():
            if mid not in by_moodle:
                summary.append(f'! Moodle course not in the app yet: {name}')
        status = moodle.get('status', {})
        for mid, acts in moodle.get('activities', {}).items():
            cid = by_moodle.get(mid)
            if not cid:
                continue
            for mod, name, cmid, dates in acts:
                if not cmid:
                    continue
                title, dd = clean_title(name), activity_dates(dates)
                opens, due = dd.get('opens', ('', '')), dd.get('due', ('', ''))
                date = due[0] or opens[0]
                if not date:
                    continue
                claimed.add((cid, due[0] or date))
                iid, done = 'm-' + cmid, status.get(cmid) == 'submitted'
                cur = items.get(iid)
                if cur is None:
                    typ = kind_for(mod, title)
                    put({'id': iid, 'c': cid, 'type': typ, 'n': next_n(cid, typ), 'title': title, 'date': date, 'time': due[1] if due[0] else '',
                         'opens': opens[0], 'opensTime': opens[1] if opens[0] else '', 'weight': None, 'status': 'done' if done else 'todo',
                         'link': f'https://moodle.huji.ac.il/2026-27/mod/{mod}/view.php?id={cmid}', 'note': '', 'source': 'moodle'}, f'+ {courses[cid]["short"]}: {title}')
                    continue
                new = dict(cur)
                if due[0] and (cur.get('date'), cur.get('time')) != due:
                    new.update(date=due[0], time=due[1])
                if opens[0] and (cur.get('opens'), cur.get('opensTime')) != opens:
                    new.update(opens=opens[0], opensTime=opens[1])
                if done and cur.get('status') == 'todo':
                    new['status'] = 'done'
                if new != cur:
                    put(new, f'~ {courses[cid]["short"]}: {cur.get("title")} ' + ('marked submitted' if new['status'] != cur.get('status') else 'dates changed'))
        # Panopto recordings -> the lecture or tutorial they belong to
        known = set()
        for it in items.values():
            known.update(re.findall(UUID, (it.get('link') or '') + ' ' + (it.get('note') or '')))
        for mid, recs in moodle.get('panopto', {}).items():
            cid = by_moodle.get(mid)
            if not cid:
                continue
            for title, uuid in sorted(recs):
                if uuid in known:
                    continue
                known.add(uuid)
                m = re.search(r'(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})', title)
                if not m:
                    continue
                ds = m.group(1)
                if '.' in ds:
                    d_, m_, y_ = ds.split('.'); ds = f'{y_}-{int(m_):02d}-{int(d_):02d}'
                date = dt.date.fromisoformat(ds)
                typ = 'Tutorial' if re.search(r'תרגיל|תרגול|recitation|tutorial', title, re.I) else 'Lecture'
                url = f'https://huji.cloud.panopto.eu/Panopto/Pages/Viewer.aspx?id={uuid}&instance=HUJI26'
                wk0 = date - dt.timedelta(days=jsday(date))
                same_day = [x for x in items.values() if x['c'] == cid and x['type'] == typ and x['date'] == ds]
                same_week = sorted([x for x in items.values() if x['c'] == cid and x['type'] == typ and wk0.isoformat() <= x['date'] <= (wk0 + dt.timedelta(days=6)).isoformat()], key=lambda x: x['date'])
                target = (same_day or same_week or [None])[0]
                if target is None:
                    put({'id': 'p-' + uuid[:8], 'c': cid, 'type': typ, 'n': next_n(cid, typ), 'title': f'{typ} {next_n(cid, typ)}', 'date': ds, 'time': '', 'opens': '',
                         'weight': None, 'status': 'todo', 'topic': '', 'link': url, 'note': '', 'source': 'panopto'}, f'+ {courses[cid]["short"]}: recording "{title}"')
                elif not target.get('link'):
                    put(dict(target, link=url), f'~ {courses[cid]["short"]}: {target["title"]} recording added')
                else:
                    note = (target.get('note') or '').rstrip()
                    put(dict(target, note=(note + '\n' if note else 'Other recordings:\n') + url), f'~ {courses[cid]["short"]}: {target["title"]} extra recording')

    # calendar feed: deadlines the browser data didn't cover
    ics, err = None, None
    feed = open(ICS_URL_FILE).read().strip()
    for attempt in range(4):  # HUJI's server sometimes resets connections; retry, then fall back to curl
        try:
            if attempt < 3:
                ics = urllib.request.urlopen(urllib.request.Request(feed, headers={'User-Agent': 'Mozilla/5.0 (Macintosh) SemesterCatchUp/1.0'}), timeout=30, context=SSL).read().decode('utf-8')
            else:
                ics = subprocess.run(['/usr/bin/curl', '-fsS', '--retry', '3', '--max-time', '40', feed], capture_output=True, text=True, check=True).stdout
            if 'BEGIN:VCALENDAR' in ics:
                break
            ics = None
        except Exception as e:
            err = e; time.sleep(2 + attempt * 3)
    if ics is None:
        summary.append(f'! Calendar feed failed: {err}')
    if ics:
        groups = {}
        for e in parse_ics(ics):
            cid = by_code.get(re.split(r'[-_]', e.get('CATEGORIES', ''))[0].strip())
            if not cid or re.search(r'נוכחות|attendance', e.get('SUMMARY', ''), re.I):
                continue
            base_t, kind = ics_base(e.get('SUMMARY', ''))
            g = groups.setdefault((cid, base_t), {'uid': e.get('UID', '')})
            g[kind] = (e['_dt'].strftime('%Y-%m-%d'), e['_dt'].strftime('%H:%M'))
        for (cid, base_t), g in groups.items():
            due, opens = g.get('due'), g.get('opens')
            if due and (cid, due[0]) in claimed:
                continue
            mine = {k: x for k, x in items.items() if x['c'] == cid and x['type'] not in ('Lecture', 'Tutorial', 'Online unit')}
            match = next((k for k, x in mine.items() if x.get('icsUid') == g['uid'] or clean_title(x.get('title', '')).lower() == base_t.lower()), None)
            match = match or (due and next((k for k, x in mine.items() if x.get('date') == due[0]), None)) or (opens and next((k for k, x in mine.items() if x.get('opens') == opens[0]), None))
            if match:
                if moodle is None:
                    cur = items[match]; new = dict(cur)
                    if due and (cur.get('date'), cur.get('time')) != due:
                        new.update(date=due[0], time=due[1])
                    if opens and not cur.get('opens'):
                        new.update(opens=opens[0], opensTime=opens[1])
                    if new != cur:
                        put(new, f'~ {courses[cid]["short"]}: {cur["title"]} dates from the calendar feed')
                continue
            if not (due or opens):
                continue
            iid = 'i-' + re.sub(r'[^0-9A-Za-z]', '', g['uid'].split('@')[0])[:40]
            if iid in items:
                continue
            typ = kind_for('', base_t)
            put({'id': iid, 'c': cid, 'type': typ, 'n': next_n(cid, typ), 'title': base_t, 'date': (due or opens)[0], 'time': due[1] if due else '',
                 'opens': opens[0] if opens else '', 'opensTime': opens[1] if opens else '', 'weight': None, 'status': 'todo', 'link': '', 'note': '',
                 'source': 'moodle-calendar', 'icsUid': g['uid']}, f'+ {courses[cid]["short"]}: {base_t} (from the calendar feed)')

    if not a.dry_run:
        rows = [{'user_id': uid, 'col': 'item', 'id': i, 'data': it} for i, it in changed.items()]
        prefs = next((r['data'] for r in req('GET', f'{base}?user_id=eq.{uid}&col=eq.settings&id=eq.prefs&select=data', cfg['service_key'])), {}) or {}
        rows.append({'user_id': uid, 'col': 'settings', 'id': 'prefs', 'data': dict(prefs, lastSync=NOW)})
        for i in range(0, len(rows), 300):
            req('POST', base + '?on_conflict=user_id,col,id', cfg['service_key'], rows[i:i + 300], {'Prefer': 'resolution=merge-duplicates,return=minimal'})
    print(f'{len(changed)} changes' + (' (dry run, nothing written)' if a.dry_run else ''))
    for line in summary:
        print(line)
    if not summary:
        print('Moodle sync: nothing new.')


if __name__ == '__main__':
    main()
