#!/usr/bin/env python3
"""What Claude's daily run uses to read the semester and change it. Every change it makes also
lands in the app's "What's new" feed with the reason and an Undo.

  claude_edit.py summary                                     courses, profiles and the next three weeks, for context
  claude_edit.py rule COURSE "what I learned" --why "..."    add a sentence to a course's profile.rules
  claude_edit.py profile COURSE KEY JSON --why "..."         set a course profile key (e.g. trackTutorials false)
  claude_edit.py importance ITEM -1|0|1 --why "..."          nudge a task; skipped if the user set it themselves
  claude_edit.py insight "text" [--course COURSE]            add one insight to the Overview

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
    recent = sorted(s.get('insight').values(), key=lambda i: i.get('at', ''))[-5:]
    print('RECENT INSIGHTS (do not repeat these; add one only if it says something new)')
    for i in recent:
        print(f"  {i.get('at', '')[:10]} {i.get('course', '')} | {i.get('text', '')}")
    qs = s.get('question')
    print(f"QUESTIONS open={sum(1 for q in qs.values() if q.get('status', 'open') == 'open')} answered-unused={sum(1 for q in qs.values() if q.get('status') == 'answered')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['summary', 'rule', 'profile', 'importance', 'insight'])
    ap.add_argument('args', nargs='*')
    ap.add_argument('--why', default='')
    ap.add_argument('--course', default='')
    a = ap.parse_args()
    s = Store()

    if a.cmd == 'summary':
        return summary(s)

    if a.cmd == 'insight':
        text = ' '.join(a.args)
        if a.course and not a.course.startswith('m-'):  # accept a short name like COMP
            match = [cid for cid, c in s.get('course').items() if (c.get('short') or '').lower() == a.course.lower()]
            a.course = match[0] if match else a.course
        s.put('insight', [{'id': f'i-{STAMP}', 'text': text, 'course': a.course, 'at': NOW, 'source': 'claude'}])
        return print('Insight added.')

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
