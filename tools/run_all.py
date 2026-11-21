#!/usr/bin/env python3
"""Runs the sync for every student who connected Moodle in the app (the hourly cloud job calls this).

Usage: run_all.py [--dry-run] [--only USER_ID]
For each student, in order:
  1. semester_setup.py   adds courses they're enrolled in that the app doesn't have yet (a new account's whole semester)
  2. moodle_api.py       reads their Moodle through the app key
  3. moodle_sync.py      tasks, quizzes, submissions, announcements, recording links
  4. shnaton.py          exam dates, hours and rooms (once a day)
Each student's run is separate: one failing doesn't stop the others. The private calendar link (MOODLE_ICS_URL) belongs
to the account in SUPABASE_EMAIL and is only used for that account. Students are named by the last 4 characters of
their id, never by email. Credentials as in supabase_load.py.
"""
import argparse, os, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from supabase_load import req, user_id, load_cfg  # noqa: E402


def students(cfg):
    """Everyone with a saved Moodle connection, plus the owner account (which may sync from the calendar link alone)."""
    rows = req('GET', f"{cfg['url']}/rest/v1/docs?col=eq.settings&id=eq.moodle&select=user_id,data", cfg['service_key'])
    ids = [r['user_id'] for r in rows if (r.get('data') or {}).get('token')]
    owner = None
    if cfg.get('email'):
        try:
            owner = user_id(dict(cfg, user_id=None))
        except SystemExit:
            owner = None
    if owner and owner not in ids:
        ids.insert(0, owner)
    return sorted(set(ids), key=lambda u: (u != owner, u)), owner


# How long each tool may take for one student, in seconds. Together they stay well inside the cloud job's limit,
# so one slow server (HUJI's Moodle at night, the Shnaton) can't stop the sync for everyone.
BUDGET = {'semester_setup.py': 150, 'moodle_api.py': 240, 'moodle_sync.py': 120, 'shnaton.py': 120}


def run(tool, env, *args, capture=None):
    """Runs one tool for one student, within its time budget. Returns True when it finished without an error."""
    cmd = [sys.executable, '-u', os.path.join(HERE, tool), *args]
    started = time.time()
    try:
        if capture:
            with open(capture, 'w') as out:
                r = subprocess.run(cmd, env=env, stdout=out, stderr=subprocess.PIPE, text=True, timeout=BUDGET.get(tool, 120))
        else:
            r = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=BUDGET.get(tool, 120))
            print(''.join('  ' + line + '\n' for line in (r.stdout or '').splitlines()), end='')
        if r.returncode != 0:
            tail = (r.stderr or '').strip().splitlines()[-1:] if capture else []
            print(f'  ! {tool} failed' + (': ' + tail[0] if tail else ''), flush=True)
        print(f'  ({tool}: {time.time() - started:.0f} s)', flush=True)
        return r.returncode == 0
    except subprocess.TimeoutExpired as e:
        print(''.join('  ' + line + '\n' for line in (e.stdout or b'').decode(errors='replace').splitlines()) if isinstance(e.stdout, bytes) else (e.stdout or ''), end='')
        print(f'  ! {tool} took longer than {BUDGET.get(tool, 120)} s and was stopped; the next hourly run tries again', flush=True)
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--only')
    a = ap.parse_args()
    cfg = load_cfg()
    ids, owner = students(cfg)
    if a.only:
        ids = [u for u in ids if u == a.only]
    dry = ['--dry-run'] if a.dry_run else []
    failed = 0
    for n, uid in enumerate(ids, 1):
        print(f'Student {n} of {len(ids)} (…{uid[-4:]})' + (', the owner' if uid == owner else ''), flush=True)
        env = dict(os.environ, SUPABASE_USER_ID=uid)
        if uid != owner:
            env.pop('MOODLE_ICS_URL', None)
            env['SEMESTER_NO_CALENDAR_LINK'] = '1'
        ok = run('semester_setup.py', env, *dry)
        with tempfile.TemporaryDirectory() as tmp:
            snap = os.path.join(tmp, 'moodle.json')
            if not run('moodle_api.py', env, capture=snap):
                with open(snap, 'w') as f:
                    f.write('{"error":"api-failed"}')
            ok = run('moodle_sync.py', env, '--moodle', snap, *dry) and ok
        run('shnaton.py', env, *dry)  # HUJI's catalog being down shouldn't fail the run
        failed += 0 if ok else 1
    if not ids:
        print('Nobody has connected Moodle yet.')
    if ids and failed == len(ids):
        sys.exit('Every student failed.')


if __name__ == '__main__':
    main()
