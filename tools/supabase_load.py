#!/usr/bin/env python3
"""Upload documents into the app's Supabase table for one user.

Usage: supabase_load.py DATA.json [--replace]
Credentials come from the environment (SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_EMAIL), as in the cloud job,
or else from ~/.config/semester-catchup/supabase.local.json: {"url": "...", "service_key": "...", "email": "..."}.
The service key is never committed. --replace deletes the user's existing rows first.
"""
import json, os, ssl, sys, urllib.request

CFG = os.path.expanduser('~/.config/semester-catchup/supabase.local.json')
# python.org builds of Python ship without CA certificates; use the Mac's own bundle when present.
SSL = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()


def load_cfg():
    # In a Claude cloud routine the key is added to requests by the environment's network secret,
    # so the session never holds it: SUPABASE_KEY_VIA_PROXY=1 plus SUPABASE_URL and SUPABASE_USER_ID.
    if os.environ.get('SUPABASE_KEY_VIA_PROXY'):
        return {'url': os.environ['SUPABASE_URL'], 'service_key': '', 'email': os.environ.get('SUPABASE_EMAIL', ''),
                'user_id': os.environ['SUPABASE_USER_ID']}
    if os.environ.get('SUPABASE_SERVICE_KEY'):
        return {'url': os.environ['SUPABASE_URL'], 'service_key': os.environ['SUPABASE_SERVICE_KEY'], 'email': os.environ['SUPABASE_EMAIL']}
    return json.load(open(CFG))


def req(method, url, key, body=None, extra=None):
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'} if key else {'Content-Type': 'application/json'}
    h.update(extra or {})
    r = urllib.request.Request(url, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=60, context=SSL) as resp:
        txt = resp.read().decode() or 'null'
        return json.loads(txt)


def user_id(cfg):
    if cfg.get('user_id'):
        return cfg['user_id']
    users = req('GET', cfg['url'] + '/auth/v1/admin/users?per_page=200', cfg['service_key'])
    users = users.get('users', users) if isinstance(users, dict) else users
    for u in users:
        if (u.get('email') or '').lower() == cfg['email'].lower():
            return u['id']
    sys.exit(f'No app account for {cfg["email"]} yet. Open the app, create the account, then run this again.')


def main():
    cfg = load_cfg()
    data = json.load(open(sys.argv[1]))
    uid = user_id(cfg)
    base = cfg['url'] + '/rest/v1/docs'
    if '--replace' in sys.argv:
        req('DELETE', f'{base}?user_id=eq.{uid}', cfg['service_key'])
    rows = [{'user_id': uid, 'col': 'course', 'id': c['id'], 'data': c} for c in data['courses']]
    rows += [{'user_id': uid, 'col': 'item', 'id': it['id'], 'data': it} for it in data['items']]
    rows.append({'user_id': uid, 'col': 'settings', 'id': 'prefs', 'data': data.get('prefs', {})})
    for i in range(0, len(rows), 300):
        req('POST', base + '?on_conflict=user_id,col,id', cfg['service_key'], rows[i:i + 300], {'Prefer': 'resolution=merge-duplicates,return=minimal'})
    print(f'Loaded {len(rows)} documents for {cfg["email"]}')


if __name__ == '__main__':
    main()
