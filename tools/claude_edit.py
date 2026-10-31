#!/usr/bin/env python3
"""What Claude's daily run uses to read the semester and change it. Every change it makes also
lands in the app's "What's new" feed with the reason and an Undo.

  claude_edit.py summary                                     courses, profiles and the next three weeks, for context
  claude_edit.py rule COURSE "what I learned" --why "..."    add a sentence to a course's profile.rules
  claude_edit.py profile COURSE KEY JSON --why "..."         set a course profile key (e.g. trackTutorials false)
  claude_edit.py importance ITEM -1|0|1 --why "..."          nudge a task; skipped if the user set it themselves
  claude_edit.py insight "text" [--course COURSE] [--about A_ID ...]
                                                             add one insight to the Overview; --about names the
                                                             announcements it sums up (the app links back to them)
  claude_edit.py reviewed A_ID [A_ID ...]                    announcements you read that need no insight
  claude_edit.py brief YYYY-MM-DD "text"                     the evening notification's summary of that day
  claude_edit.py reply MSG_ID "text" [--items ID ...]        answer the student's chat message in the app; --items
                                                             shows those tasks/lectures as tappable cards under it
  claude_edit.py tips off|on KIND                            turn one of the app's own tips off/on
                                                             (exam, behind, week, opens, attend)

COURSE and ITEM are ids as printed by `summary` (e.g. m-6441, m-169162).
"""
import argparse
import datetime as dt
import json
import re

from supabase_load import load_cfg, req, user_id

NOW = dt.datetime.now().astimezone().isoformat(timespec='seconds')
STAMP = re.sub(r'\D', '', NOW[:19])


class Store:
    def __init__(self):
        self.cfg = load_cfg()
        self.uid = user_id(self.cfg)
        self.base = self.cfg['url'] + '/rest/v1/docs'

    def get(self, col, id_=None):
        q = f'{self.base}?user_id=eq.{self.uid}&col=eq.{col}&select=id,data&limit=10000' + (f'&id=eq.{id_}' if id_ else '')
        return {r['id']: r['data'] for r in req('GET', q, self.cfg['service_key'])}

    def put(self, col, docs):
        body = [{'user_id': self.uid, 'col': col, 'id': d['id'], 'data': d} for d in docs]
        req('POST', self.base + '?on_conflict=user_id,col,id', self.cfg['service_key'], body,
            {'Prefer': 'resolution=merge-duplicates,return=minimal'})

    def log(self, why, undo, course='', item=''):
        n = len(self.get('update'))
        self.put('update', [{'id': f'c-{STAMP}-{n}', 'kind': 'claude', 'text': why, 'course': course, 'item': item,
                             'at': NOW, 'seen': False, 'source': 'claude', 'undo': undo}])


def summary(s):
    courses, items = s.get('course'), s.get('item')
    prefs = (s.get('settings', 'prefs').get('prefs') or {})
    notes = s.get('note')
    chat = sorted((n for n in notes.values() if n.get('kind') == 'chat'), key=lambda n: n.get('at', ''))
    print('CHAT (the student writes to you in the app; answer every message marked NEEDS ANSWER with `reply`)')
    for m in chat[-12:]:
        flag = '' if m.get('from') == 'claude' or m.get('answered') else '  NEEDS ANSWER'
        cards = f" [cards: {', '.join(m['items'])}]" if m.get('items') else ''
        print(f"  {m['id']} {m.get('at', '')[:16]} {m.get('from')}: {m.get('text', '')}{cards}{flag}")
    if not chat:
        print('  none')
    print('WHAT THE STUDENT WANTS FROM YOU (their own words, from Settings)')
    print('  ' + (prefs.get('claudeGuidance') or 'nothing written yet'))
    fb = sorted((i for i in s.get('insight').values() if isinstance(i.get('feedback'), dict)), key=lambda i: i['feedback'].get('at', ''))[-12:]
    # The student's plan of action, in order, with their named slots (a slot holds the items after it).
    slots = prefs.get('planSlots') or {}
    plan = [e for e in prefs.get('plan') or [] if (e in slots if e.startswith('slot:') else e in items)]
    print('PLAN (the order the student chose; "## name" is a slot of the items under it)')
    for e in plan:
        if e.startswith('slot:'):
            print(f'  ## {slots[e]}')
        else:
            i = items[e]
            print(f"    {e} {courses.get(i['c'], {}).get('short')} {i['type']} | {i['title']} | {i['date']} | {i.get('status', 'todo')}")
    if not plan:
        print('  empty')
    print("FEEDBACK ON YOUR INSIGHTS (learn from it: write fewer of what they didn't find useful)")
    for i in fb:
        f = i['feedback']
        print(f"  {'useful' if f.get('useful') else 'NOT useful'}{' (' + f['reason'] + ')' if f.get('reason') else ''}: {i.get('text', '')}")
    if not fb:
        print('  none yet')
    print(f"  App tips the student turned off: {', '.join(prefs.get('mutedTips') or []) or 'none'}")
    today = dt.date.today().isoformat()
    soon = (dt.date.today() + dt.timedelta(days=21)).isoformat()
    sessions = {'Lecture', 'Tutorial', 'Online unit'}
    print('COURSES')
    for c in sorted(courses.values(), key=lambda c: c.get('order', 99)):
        behind = sum(1 for i in items.values() if i['c'] == c['id'] and i['type'] in sessions and i['date'] <= today
                     and i.get('status') not in ('done', 'skip') and not i.get('hidden'))
        print(f"  {c['id']} {c.get('short')} · {c.get('name')} · {behind} lectures behind · profile {json.dumps(c.get('profile', {}), ensure_ascii=False)}")
    print('TASKS, next 3 weeks and overdue (id course type title due weight status myImportance locked)')
    for i in sorted(items.values(), key=lambda i: i['date']):
        if i['type'] in sessions or i.get('hidden') or i['date'] > soon or (i['date'] < today and i.get('status') in ('done', 'skip')):
            continue
        print(f"  {i['id']} {courses.get(i['c'], {}).get('short')} {i['type']} | {i['title']} | {i['date']} {i.get('time', '')}"
              f" | w={i.get('weight')} | {i.get('status', 'todo')} | imp={i.get('myImportance', 0)} | locked={i.get('locked', [])}")
    print('LECTURES AND TUTORIALS HELD, NOT WATCHED YET (id course type title date status)')
    behind = [i for i in sorted(items.values(), key=lambda i: i['date']) if i['type'] in sessions and i['date'] <= today and not i.get('hidden')
              and i.get('status') not in ('done', 'skip', 'attended', 'reviewed') and not (courses.get(i['c'], {}).get('profile') or {}).get('hidden')]
    for i in behind[-40:]:
        print(f"  {i['id']} {courses.get(i['c'], {}).get('short')} {i['type']} | {i['title']} | {i['date']} | {i.get('status', 'todo')}")
    if not behind:
        print('  none')
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    print(f'TOMORROW {tomorrow} (everything on that day: id course type title time status)')
    day = sorted((i for i in items.values() if i['date'] == tomorrow and not i.get('hidden')
                  and not (courses.get(i['c'], {}).get('profile') or {}).get('hidden')), key=lambda i: i.get('time') or '99')
    for i in day:
        print(f"  {i['id']} {courses.get(i['c'], {}).get('short')} {i['type']} | {i['title']} | {i.get('time') or 'no time'} | {i.get('status', 'todo')}")
    if not day:
        print('  nothing')
    # How finished work went, in the student's own words (the app asks after they finish something).
    two_weeks = (dt.date.today() - dt.timedelta(days=21)).isoformat()
    refl = sorted((i for i in items.values() if isinstance(i.get('reflection'), dict) and not i['reflection'].get('skipped')
                   and i['reflection'].get('at', '') >= two_weeks), key=lambda i: i['reflection'].get('at', ''))
    print('HOW IT WENT, last 3 weeks (difficulty 1 easy..3 hard, minutes taken, followed 1 yes..3 lost)')
    for i in refl:
        r = i['reflection']
        bits = [f"difficulty={r['difficulty']:.0f}" if 'difficulty' in r else '', f"minutes={r['minutes']:.0f}" if 'minutes' in r else '',
                f"followed={r['followed']:.0f}" if 'followed' in r else '', f"note={r['note']!r}" if r.get('note') else '']
        print(f"  {r.get('at', '')} {courses.get(i['c'], {}).get('short')} {i['type']} | {i['title']} | " + ' '.join(b for b in bits if b))
    if not refl:
        print('  none yet')
    insights = s.get('insight')
    covered = {a for i in insights.values() for a in (i.get('about') or [])}
    covered |= set((s.get('settings', 'claude').get('claude') or {}).get('reviewedAnnouncements') or [])
    weeks_ago = (dt.datetime.now().astimezone() - dt.timedelta(days=14)).isoformat()
    news = sorted((u for u in s.get('update').values() if u.get('kind') == 'announcement' and u['id'] not in covered
                   and u.get('at', '') >= weeks_ago), key=lambda u: u.get('at', ''))
    print('NEW ANNOUNCEMENTS (not yet summed up; the student reads them in the course tab, not the Overview)')
    for u in news:
        body = re.sub(r'\s*\n\s*', ' / ', u.get('detail', ''))
        print(f"  {u['id']} {courses.get(u.get('course'), {}).get('short')} {u.get('at', '')[:16]} | {u.get('text', '')} | {body}")
    if not news:
        print('  none')
    recent = sorted((i for i in insights.values() if i.get('kind') != 'brief'), key=lambda i: i.get('at', ''))[-5:]
    print('RECENT INSIGHTS (do not repeat these; add one only if it says something new)')
    for i in recent:
        print(f"  {i.get('at', '')[:10]} {i.get('course', '')} | {i.get('text', '')}")
    qs = s.get('question')
    print(f"QUESTIONS open={sum(1 for q in qs.values() if q.get('status', 'open') == 'open')} answered-unused={sum(1 for q in qs.values() if q.get('status') == 'answered')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['summary', 'rule', 'profile', 'importance', 'insight', 'reviewed', 'brief', 'reply', 'tips'])
    ap.add_argument('args', nargs='*')
    ap.add_argument('--why', default='')
    ap.add_argument('--course', default='')
    ap.add_argument('--about', nargs='*', default=[])
    ap.add_argument('--items', nargs='*', default=[])
    a = ap.parse_args()
    s = Store()

    if a.cmd == 'summary':
        return summary(s)

    if a.cmd == 'insight':
        text = ' '.join(a.args)
        if a.course and not a.course.startswith('m-'):  # accept a short name like COMP
            match = [cid for cid, c in s.get('course').items() if (c.get('short') or '').lower() == a.course.lower()]
            a.course = match[0] if match else a.course
        doc = {'id': f'i-{STAMP}', 'text': text, 'course': a.course, 'at': NOW, 'source': 'claude'}
        if a.about:
            updates = s.get('update')
            missing = [x for x in a.about if x not in updates]
            assert not missing, f'unknown announcement ids: {missing}'
            doc['about'] = a.about
            if not a.course:
                doc['course'] = updates[a.about[0]].get('course', '')
        s.put('insight', [doc])
        return print('Insight added.')

    if a.cmd == 'reply':
        mid, text = a.args[0], ' '.join(a.args[1:])
        notes = s.get('note')
        assert mid in notes, f'no chat message {mid}'
        assert text, 'write the reply'
        items = s.get('item')
        missing = [x for x in a.items if x not in items]
        assert not missing, f'unknown item ids: {missing}'
        doc = {'id': f'r-{STAMP}', 'kind': 'chat', 'from': 'claude', 'text': text, 'at': NOW, 'replyTo': mid}
        if a.items:
            doc['items'] = a.items
        s.put('note', [doc, dict(notes[mid], answered=True)])
        return print('Reply sent.')

    if a.cmd == 'tips':
        state, kind = a.args[0], a.args[1]
        assert state in ('on', 'off') and kind in ('exam', 'behind', 'week', 'opens', 'attend'), 'tips off|on exam|behind|week|opens|attend'
        cur = s.get('settings', 'prefs').get('prefs') or {'id': 'prefs'}
        muted = set(cur.get('mutedTips') or [])
        muted = muted - {kind} if state == 'on' else muted | {kind}
        s.put('settings', [dict(cur, id='prefs', mutedTips=sorted(muted))])
        s.log(f"Turned {state} the app's {kind} tips, as you asked.", [])
        return print(f'{kind} tips {state}.')

    if a.cmd == 'brief':
        day, text = a.args[0], ' '.join(a.args[1:])
        dt.date.fromisoformat(day)
        assert text, 'write the brief text'
        s.put('insight', [{'id': f'b-{day}', 'kind': 'brief', 'date': day, 'text': text, 'at': NOW, 'source': 'claude'}])
        return print(f'Brief for {day} saved.')

    if a.cmd == 'reviewed':
        cur = s.get('settings', 'claude').get('claude') or {'id': 'claude'}
        done = list(dict.fromkeys((cur.get('reviewedAnnouncements') or []) + a.args))[-300:]
        s.put('settings', [dict(cur, id='claude', reviewedAnnouncements=done)])
        return print(f'{len(a.args)} announcement(s) marked as read.')

    assert a.why, '--why is required: say what you changed and because of what, in one plain sentence'
    if a.cmd in ('rule', 'profile'):
        cid = a.args[0]
        c = s.get('course', cid)[cid]
        prof = dict(c.get('profile') or {})
        key = 'rules' if a.cmd == 'rule' else a.args[1]
        old = prof.get(key)
        prof[key] = (old or []) + [a.args[1]] if a.cmd == 'rule' else json.loads(a.args[2])
        s.put('course', [dict(c, profile=prof)])
        s.log(a.why, [{'col': 'course', 'id': cid, 'profile': {key: old}}], course=cid)
        return print(f'{cid} profile.{key} updated.')

    if a.cmd == 'importance':
        iid, val = a.args[0], int(a.args[1])
        it = s.get('item', iid)[iid]
        if 'myImportance' in (it.get('locked') or []):
            return print(f'{iid}: skipped, the user set its importance themselves.')
        old = it.get('myImportance')
        new = dict(it)
        if val:
            new['myImportance'] = val
        else:
            new.pop('myImportance', None)
        s.put('item', [new])
        s.log(a.why, [{'col': 'item', 'id': iid, 'set': {'myImportance': old}}], course=it['c'], item=iid)
        return print(f'{iid} importance {old or 0} -> {val}.')


if __name__ == '__main__':
    main()
