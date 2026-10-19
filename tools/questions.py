#!/usr/bin/env python3
"""Claude's questions in the iPhone app.

  questions.py add FILE.json      add or replace questions (a JSON list; each needs id, kind, text)
  questions.py answered           print answered questions Claude hasn't used yet, as JSON
  questions.py done ID [ID ...]   mark questions as used once Claude has acted on the answer
  questions.py list               print every question with its status

A question looks like:
  {"id": "q-...", "kind": "choice", "text": "...", "detail": "...", "course": "m-6441",
   "options": [{"id": "yes", "label": "Yes", "effects": [{"col": "item", "id": "m-1", "set": {"status": "done"}}]}]}
or, to put things in order:
  {"id": "q-...", "kind": "rank", "text": "...", "items": [{"id": "m-1", "label": "..."}]}
Effects run in the app as soon as the user answers; they may set an item's status, myImportance or hidden,
or any key of a course's profile.
"""
import datetime as dt
import json
import sys

from supabase_load import CFG, req, user_id


def rows(cfg, uid, extra=''):
    return req('GET', f"{cfg['url']}/rest/v1/docs?user_id=eq.{uid}&col=eq.question&select=id,data{extra}", cfg['service_key'])


def upsert(cfg, uid, qs):
    body = [{'user_id': uid, 'col': 'question', 'id': q['id'], 'data': q} for q in qs]
    req('POST', f"{cfg['url']}/rest/v1/docs?on_conflict=user_id,col,id", cfg['service_key'], body,
        {'Prefer': 'resolution=merge-duplicates,return=minimal'})


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cfg = json.load(open(CFG))
    uid = user_id(cfg)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'add':
        qs = json.load(open(args[0]))
        now = dt.datetime.now().astimezone().replace(microsecond=0)
        for i, q in enumerate(qs):  # one second apart, so the app shows them in file order
            assert q.get('id') and q.get('kind') in ('choice', 'rank') and q.get('text'), f'bad question: {q}'
            q.setdefault('askedAt', (now + dt.timedelta(seconds=i)).isoformat())
            q.setdefault('status', 'open')
        upsert(cfg, uid, qs)
        print(f'Added {len(qs)} questions.')
    elif cmd == 'answered':
        out = [r['data'] for r in rows(cfg, uid) if r['data'].get('status') == 'answered']
        print(json.dumps(out, ensure_ascii=False, indent=1))
    elif cmd == 'done':
        by_id = {r['id']: r['data'] for r in rows(cfg, uid)}
        qs = [dict(by_id[i], status='done') for i in args if i in by_id]
        upsert(cfg, uid, qs)
        print(f'Marked {len(qs)} as done.')
    elif cmd == 'list':
        for r in sorted(rows(cfg, uid), key=lambda r: r['data'].get('askedAt', '')):
            d = r['data']
            print(f"{d.get('status', 'open'):9} {r['id']:24} {d.get('text', '')}")
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
