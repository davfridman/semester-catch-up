#!/usr/bin/env python3
"""Runs the shared rule cases (contract/fixtures/rules.json) that the Python tools implement themselves.

Usage: contract_rules.py
Most rules (status texts, importance, ranking, catch-up percent, weeks, date styles) live only in the apps.
The tools implement two, both in claude_edit.py for Claude's daily summary:
  plan_model  reading prefs.plan and prefs.planSlots          -> every case in rules.json's plan section
  is_behind   a lecture or tutorial held and not yet watched  -> the status cases for sessions (behind exactly when
                                                                 the apps say "watch") and catchUp's behind count
No network and no credentials. Exits 1 if any case fails.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from claude_edit import SESSIONS, is_behind, plan_model, plan_ids  # noqa: E402

FIXTURE = os.path.join(HERE, '..', 'contract', 'fixtures', 'rules.json')


def main():
    f = json.load(open(FIXTURE))
    today = f['now']
    fails, counts = [], {}

    def expect(section, ok, what):
        counts[section] = counts.get(section, 0) + 1
        if not ok:
            fails.append(f'{section}: {what}')

    for c in f['plan']['cases']:
        exists = set(f['plan']['items']).__contains__
        entries, slots = plan_model({'plan': c.get('plan'), 'planSlots': c.get('planSlots')}, exists)
        got = {'entries': entries, 'slots': slots, 'ids': plan_ids(entries, slots)}
        for k in ('entries', 'slots', 'ids'):
            expect('plan', got[k] == c[k], f"{c['name']}: {k} {json.dumps(got[k])}, expected {json.dumps(c[k])}")
    for c in f['status']:
        it = c['item']
        if it['type'] in SESSIONS:
            want = c['key'] == 'watch'
            expect('behind', is_behind(it, today) == want, f"{it['id']} behind={not want}, expected {want} (status {c['key']})")
    n = sum(is_behind(it, today) for it in f['catchUp']['items'])
    expect('behind', n == f['catchUp']['behind'], f"catchUp: {n} behind, expected {f['catchUp']['behind']}")

    total = sum(counts.values())
    print(f'Python rules: {total - len(fails)}/{total} checks pass (' + ', '.join(f'{k} {v}' for k, v in counts.items()) + ')')
    for x in fails:
        print('  FAIL ' + x)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
