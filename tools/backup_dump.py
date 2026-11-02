#!/usr/bin/env python3
"""Write every row of every table in the app's Supabase project, plus the account list, to one JSON file.

Usage: backup_dump.py OUT.json
Run nightly by semester-sync's backup workflow, which encrypts the file before keeping it.
Credentials come from the environment or ~/.config/semester-catchup/supabase.local.json (see supabase_load.py).
Prints counts only, never data or keys.
"""
import datetime, json, sys
from supabase_load import load_cfg, req


def main():
    cfg = load_cfg()
    key, base = cfg['service_key'], cfg['url'] + '/rest/v1/'
    spec = req('GET', base, key, extra={'Accept': 'application/openapi+json'})
    tables = sorted(p.strip('/') for p in spec.get('paths', {}) if p.strip('/') and not p.startswith('/rpc'))
    out = {'takenAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'), 'tables': {}}
    for t in tables:
        rows, off = [], 0
        while True:
            page = req('GET', f'{base}{t}?select=*&limit=1000&offset={off}', key)
            rows += page
            off += 1000
            if len(page) < 1000:
                break
        out['tables'][t] = rows
    users = req('GET', cfg['url'] + '/auth/v1/admin/users?per_page=1000', key)
    users = users.get('users', users) if isinstance(users, dict) else users
    out['users'] = [{k: u.get(k) for k in ('id', 'email', 'created_at', 'last_sign_in_at')} for u in users]
    json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False)
    print('Backed up', ', '.join(f'{t}: {len(r)} rows' for t, r in out['tables'].items()), f'· {len(out["users"])} accounts')


if __name__ == '__main__':
    main()
