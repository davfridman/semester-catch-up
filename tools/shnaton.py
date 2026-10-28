#!/usr/bin/env python3
"""Keeps exam dates, times and rooms current from the HUJI Shnaton (course catalog).

Usage: shnaton.py [--dry-run] [--force]
  --dry-run  print what would change, write nothing
  --force    run even if the Shnaton was already checked today (normally once a day; the hourly job calls this)
Only reads from HUJI: the Shnaton site's own JSON API (the one shnaton.huji.ac.il/course/<code> calls).
For each visible course it updates existing exam items: x-<course>-final (the written exam's מועד א') and
x-<course>-final-b (its מועד ב', optional; created when missing), and x-<course>-q1, -q2 ... (the midterms, in date
order; their מועד ב' goes in the note unless a -q1-b item exists). Fields the student edited ('locked') are kept, and
nothing is ever deleted. A date or time change adds a 'date' card to the app's feed.
Credentials as in supabase_load.py.
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from supabase_load import req, user_id, load_cfg, SSL  # noqa: E402

API = 'https://shnaton.huji.ac.il/api'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh) SemesterCatchUp/1.0', 'Accept': 'application/json'}
NOW = dt.datetime.now().astimezone().isoformat(timespec='seconds')
STAMP = re.sub(r'\D', '', NOW[:19])
TODAY = dt.date.today()
# Sentences in a note that this script writes (and rewrites); anything else in the note is kept.
OURS = re.compile(r"^(Time:|Rooms?:|Second sitting|No second date|Time and room|Time isn|Rooms aren)")


def get(path):
    for attempt in range(3):
        try:
            r = urllib.request.Request(API + path, headers=UA)
            with urllib.request.urlopen(r, timeout=30, context=SSL) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3 + attempt * 5)


def nice(d):
    return f'{d:%a} {d.day} {d:%b %Y}'


def sitting(s):
    """A Shnaton schedule -> {date, time, end, rooms}; time is '' while only the day is set (shown as 00:00)."""
    if not s or not s.get('startTime'):
        return None
    start = dt.datetime.fromisoformat(s['startTime'])
    end = dt.datetime.fromisoformat(s['endTime']) if s.get('endTime') else start
    timed = (start.hour, start.minute) != (0, 0) or end > start
    rooms = [((r.get('name') or {}).get('he') or (r.get('name') or {}).get('en') or '').strip() for r in s.get('rooms') or []]
    return {'date': start.date().isoformat(), 'time': f'{start:%H:%M}' if timed else '', 'end': f'{end:%H:%M}' if timed and end > start else '',
            'rooms': [r for r in rooms if r]}


def span(t, end):
    if not t:
        return ''
    if not end:
        return t
    mins = (dt.datetime.strptime(end, '%H:%M') - dt.datetime.strptime(t, '%H:%M')).seconds // 60
    h, m = divmod(mins, 60)
    return f'{t}–{end} ({h} h' + (f' {m} min)' if m else ')')


def exams(code, year, period):
    """{'final': (A, B), 'q1': (A, B), ...} for the course's exams in this semester; A/B are sittings or None."""
    out, mids = {}, []
    for c in get(f'/courses/code/{code}?year={year}'):
        for a in get(f'/assignments?year={year}&courseId={c["id"]}'):
            kind = ((a.get('assignmentDefinition') or {}).get('assignmentType') or {}).get('code')
            moed = {}
            for s in a.get('schedules') or []:
                if s.get('period') in (period, None) and sitting(s):
                    moed.setdefault(s.get('moed'), sitting(s))
            if 1 not in moed:
                continue
            if kind == '0' and 'final' not in out:  # מבחן (written exam)
                out['final'] = (moed[1], moed.get(2))
            elif kind == '1':  # בוחן: מבחן חלקי ראשון / שני, מבחני אמצע
                mids.append((moed[1], moed.get(2)))
    for i, m in enumerate(sorted(mids, key=lambda m: (m[0]['date'], m[0]['time'])), 1):
        out[f'q{i}'] = m
    return out


def write_note(old, a, b):
    """The item's note with the Shnaton sentences rewritten from the sittings; the student's own sentences stay."""
    ours = []
    if a['time']:
        ours.append(f'Time: {span(a["time"], a["end"])}.')
    if a['rooms']:
        ours.append(f'Rooms: {", ".join(a["rooms"])}.')
    if b:
        when = nice(dt.date.fromisoformat(b['date'])) + (f', {span(b["time"], b["end"])}' if b['time'] else '')
        ours.append(f"Second sitting (מועד ב'): {when}" + (f' in {", ".join(b["rooms"])}.' if b['rooms'] else '.'))
    elif b is None:
        ours.append('No second date.')
    if not a['time'] and not a['rooms']:
        ours.append("Time and room aren't set yet; the Shnaton will show them.")
    elif not a['time']:
        ours.append("Time isn't set yet; the Shnaton will show it.")
    elif not a['rooms']:
        ours.append("Rooms aren't set yet; the Shnaton will show them.")
    lines = []
    for ln in (old or '').split('\n'):
        if OURS.match(ln.strip()):  # a line this script wrote before
            continue
        kept = [s for s in re.split(r'(?<=[.!?])\s+', ln.strip()) if s and not OURS.match(s)]
        if kept:
            lines.append(' '.join(kept))
    if lines:  # the Shnaton part goes at the end of the note's last line
        lines[-1] += ' ' + ' '.join(ours)
        return '\n'.join(lines)
    return ' '.join(ours)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    cfg = load_cfg()
    uid = user_id(cfg)
    base = cfg['url'] + '/rest/v1/docs'
    rows = req('GET', f'{base}?user_id=eq.{uid}&select=col,id,data&limit=10000', cfg['service_key'])
    prefs = next((r['data'] for r in rows if r['col'] == 'settings' and r['id'] == 'prefs'), {}) or {}
    if not (a.force or a.dry_run) and (prefs.get('lastShnatonSync') or '')[:10] == TODAY.isoformat():
        print('Shnaton: already checked today.')
        return
    courses = {r['id']: r['data'] for r in rows if r['col'] == 'course'}
    items = {r['id']: r['data'] for r in rows if r['col'] == 'item'}

    try:
        year = next(y['year'] for y in get('/reference-data/active-years') if y.get('current'))
    except Exception:
        year = TODAY.year + 1 if TODAY.month >= 8 else TODAY.year
    # Semester A (period 1): October to January, its exams until March. Semester B (period 2): from April.
    period = 1 if TODAY.month >= 8 or TODAY.month <= 3 else 2

    changed, updates, summary, failed = {}, {}, [], []
    for cid, c in sorted(courses.items()):
        if (c.get('profile') or {}).get('hidden') or not c.get('code'):
            continue
        num = cid.split('-', 1)[-1]
        code = str(c['code']).split('_')[0]
        try:
            found = exams(code, year, period)
        except Exception as e:
            failed.append(f'{c["short"]} ({e})')
            continue
        todo, stubs = [], {}
        for key, (sa, sb) in found.items():
            iid = f'x-{num}-{key}'
            if iid not in items:
                print(f'  {c["short"]}: the Shnaton lists {key} on {sa["date"]} but the app has no item {iid}')
            elif key == 'final' and sb and f'{iid}-b' not in items:  # a final's מועד ב' gets its own optional item
                a_ = items[iid]
                stubs[f'{iid}-b'] = {'c': cid, 'n': 2, 'id': f'{iid}-b', 'date': sb['date'], 'link': f'https://shnaton.huji.ac.il/course/{code}',
                                     'note': 'Optional second exam date (Moed B): take it if you miss Moed A or want another try.',
                                     'time': '', 'type': 'Exam', 'opens': '', 'opensTime': '', 'source': 'shnaton', 'status': 'todo',
                                     'title': a_['title'].replace('Moed A', 'Moed B') if 'Moed A' in a_.get('title', '') else 'Final exam · Moed B',
                                     'weight': a_.get('weight'), 'optional': True}
                todo += [(iid, sa, False), (f'{iid}-b', sb, False)]
            elif f'{iid}-b' in items:  # מועד ב' has its own item (x-2823-final-b)
                todo.append((iid, sa, False))
                if sb:
                    todo.append((f'{iid}-b', sb, False))
            else:  # מועד ב' goes in the note
                todo.append((iid, sa, sb))
        for iid, sa, sb in todo:
            cur = items.get(iid) or stubs[iid]
            if max(sa['date'], sb['date'] if sb else '') < TODAY.isoformat():
                continue  # over
            new = dict(cur, date=sa['date'], time=sa['time'] or cur.get('time') or '', endTime=sa['end'], rooms=sa['rooms'])
            if sb is not False:
                new.update(secondDate=sb['date'] if sb else '', secondTime=sb['time'] if sb else '')
            else:  # מועד ב' is its own item
                new.pop('secondDate', None); new.pop('secondTime', None)
            if not sa['time']:  # the day is set but not the hour yet: keep what the item had
                new['endTime'] = cur.get('endTime', '')
            for f in ('endTime', 'rooms', 'secondDate', 'secondTime'):  # no empty fields on items that never had them
                if f in new and not new[f] and f not in cur:
                    del new[f]
            new['note'] = write_note(cur.get('note'), dict(sa, time=new['time'], end=new.get('endTime', '')), sb)
            for f in cur.get('locked') or []:  # the student's edits win
                if f in cur:
                    new[f] = cur[f]
                else:
                    new.pop(f, None)
            if iid in stubs:
                changed[iid] = items[iid] = new
                line = f'{c["short"]}: {new["title"]} on {nice(dt.date.fromisoformat(new["date"]))}' + (f', {span(new["time"], new.get("endTime", ""))}' if new['time'] else '')
                summary.append('+ ' + line)
                updates[iid] = {'id': f'u-{STAMP}-{iid}', 'kind': 'new', 'text': line, 'item': iid, 'course': cid, 'at': NOW,
                                'seen': False, 'source': 'shnaton', 'link': new['link']}
                continue
            if new == cur:
                continue
            what, news = [], 'changed'
            if new['date'] != cur.get('date'):
                what.append(f'moved from {nice(dt.date.fromisoformat(cur["date"]))} to {nice(dt.date.fromisoformat(new["date"]))}' if cur.get('date')
                            else f'on {nice(dt.date.fromisoformat(new["date"]))}')
                news = 'date'
            if (new['time'], new.get('endTime', '')) != (cur.get('time') or '', cur.get('endTime', '')):
                what.append(('time ' if cur.get('time') else 'time set: ') + span(new['time'], new.get('endTime', '')))
                if new['time'] != (cur.get('time') or ''):
                    news = 'date'
            if cur.get('secondDate') and 'secondDate' in new and (new['secondDate'], new['secondTime']) != (cur['secondDate'], cur.get('secondTime', '')):
                what.append(f"second sitting now {nice(dt.date.fromisoformat(new['secondDate']))}" + (f' {new["secondTime"]}' if new['secondTime'] else '')
                            if new['secondDate'] else 'second sitting removed')
                news = 'date'
            if new.get('rooms') != cur.get('rooms') and new.get('rooms'):
                what.append('rooms: ' + ', '.join(new['rooms']))
            changed[iid] = new
            line = f'{c["short"]}: {cur.get("title")} ' + ('; '.join(what) if what else 'details from the Shnaton')
            summary.append('~ ' + line)
            if what:  # filling in fields the note already said isn't news
                updates[iid] = {'id': f'u-{STAMP}-{iid}', 'kind': news, 'text': line, 'item': iid, 'course': cid, 'at': NOW,
                                'seen': False, 'source': 'shnaton', 'link': f'https://shnaton.huji.ac.il/course/{code}'}
            for f in ('date', 'time', 'endTime', 'rooms', 'secondDate', 'secondTime', 'note'):
                if new.get(f) != cur.get(f):
                    summary.append(f'    {f}: {json.dumps(cur.get(f), ensure_ascii=False)} -> {json.dumps(new.get(f), ensure_ascii=False)}')

    if not a.dry_run:
        out = [{'user_id': uid, 'col': 'item', 'id': i, 'data': it} for i, it in changed.items()]
        out += [{'user_id': uid, 'col': 'update', 'id': u['id'], 'data': u} for u in updates.values()]
        if not failed:  # if HUJI didn't answer, try again on the next hourly run
            fresh = next((r['data'] for r in req('GET', f'{base}?user_id=eq.{uid}&col=eq.settings&id=eq.prefs&select=data', cfg['service_key'])), {}) or {}
            out.append({'user_id': uid, 'col': 'settings', 'id': 'prefs', 'data': dict(fresh, lastShnatonSync=NOW)})
        if out:
            req('POST', base + '?on_conflict=user_id,col,id', cfg['service_key'], out, {'Prefer': 'resolution=merge-duplicates,return=minimal'})
    print(f'Shnaton {year}, semester {"AB"[period - 1]}: {len(changed)} exam items changed' + (' (dry run, nothing written)' if a.dry_run else ''))
    for line in summary:
        print(line)
    if failed:
        print('! Shnaton could not be read for: ' + ', '.join(failed) + '. Will try again next run.')


if __name__ == '__main__':
    main()
