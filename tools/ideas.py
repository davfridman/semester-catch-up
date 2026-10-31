#!/usr/bin/env python3
"""The student's ideas for the app, written in the iPhone app's Settings → Ideas for the app.
Read them at the start of a development cycle, and mark them done once shipped.

  ideas.py list            open ideas, oldest first (add --all for done ones too)
  ideas.py done ID [ID ...]  mark ideas done after shipping them
"""
import argparse

from claude_edit import Store


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['list', 'done'])
    ap.add_argument('ids', nargs='*')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    s = Store()
    ideas = {k: v for k, v in s.get('note').items() if v.get('kind') == 'idea' and not v.get('hidden')}
    if a.cmd == 'list':
        rows = sorted(ideas.values(), key=lambda i: i.get('at', ''))
        for i in rows:
            if i.get('done') and not a.all:
                continue
            print(f"{i['id']}  {i.get('at', '')[:10]}  {'[done] ' if i.get('done') else ''}{i.get('text', '')}")
        if not rows:
            print('No ideas yet.')
        return
    missing = [x for x in a.ids if x not in ideas]
    assert not missing, f'unknown ideas: {missing}'
    s.put('note', [dict(ideas[x], done=True) for x in a.ids])
    print(f'{len(a.ids)} marked done.')


if __name__ == '__main__':
    main()
