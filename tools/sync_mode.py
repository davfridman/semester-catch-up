#!/usr/bin/env python3
"""The iPhone app's sync switch (davfridman/semester-project#34).

Usage: sync_mode.py [merge|whole]
  merge  (default) the app saves only the fields you changed, on top of the server's current copy
  whole  back to the old way: the app saves whole documents (use only if merge saving misbehaves)
With no argument it shows the current mode. The app picks up the change on its next download.
"""
import sys
from supabase_load import load_cfg, req, user_id


def main():
    cfg = load_cfg()
    key, base = cfg['service_key'], cfg['url'] + '/rest/v1/docs'
    uid = user_id(cfg)
    where = f'?user_id=eq.{uid}&col=eq.settings&id=eq.prefs'
    rows = req('GET', base + where + '&select=data', key)
    prefs = rows[0]['data'] if rows else {}
    if len(sys.argv) < 2:
        print('sync mode:', prefs.get('syncMode') or 'merge')
        return
    mode = sys.argv[1]
    if mode not in ('merge', 'whole'):
        sys.exit(__doc__)
    if not rows:
        sys.exit('No settings document yet; open the app once first.')
    prefs = dict(prefs)
    if mode == 'merge':
        prefs.pop('syncMode', None)
    else:
        prefs['syncMode'] = 'whole'
    req('PATCH', base + where, key, {'data': prefs}, {'Prefer': 'return=minimal'})
    print('sync mode set to', mode)


if __name__ == '__main__':
    main()
