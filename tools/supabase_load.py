#!/usr/bin/env python3
"""Upload documents into the app's Supabase table for one user.

Usage: supabase_load.py DATA.json [--replace]
Reads ~/.config/semester-catchup/supabase.local.json: {"url": "...", "service_key": "...", "email": "..."}
The service key never leaves this Mac and is never committed. --replace deletes the user's existing rows first.
"""
import json, os, sys, urllib.request

CFG = os.path.expanduser('~/.config/semester-catchup/supabase.local.json')


def req(method, url, key, body=None, extra=None):
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
    h.update(extra or {})
    r = urllib.request.Request(url, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=60) as resp:
        txt = resp.read().decode() or 'null'
        return json.loads(txt)


def user_id(cfg):
    users = req('GET', cfg['url'] + '/auth/v1/admin/users?per_page=200', cfg['service_key'])
    users = users.get('users', users) if isinstance(users, dict) else users
    for u in users:
        if (u.get('email') or '').lower() == cfg['email'].lower():
            return u['id']
    sys.exit(f'No app account for {cfg["email"]} yet. Open the app, create the account, then run this again.')


def main():
    cfg = json.load(open(CFG))
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
