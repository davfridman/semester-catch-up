#!/usr/bin/env python3
"""Change history: see what changed, when and who changed it, and undo any single change.
Reads docs_history (supabase/migrations/004_history.sql), which keeps the version before every change.

Usage:
  history.py                     the last 20 changes, newest first
  history.py -n 50               the last 50
  history.py --doc item/ID       only changes to one document (col/id)
  history.py show HID            what one change did, field by field
  history.py undo HID            puts back the fields that change touched, leaving later changes to other
                                 fields alone; shows the plan and asks before writing
  history.py undo HID --yes      the same without asking
  history.py undo HID --force    also when a later change touched the same fields (theirs is overwritten)

Undo is itself a change, so it shows up in the history and can be undone too. davfridman/semester-project#22
"""
import json, re, sys, urllib.parse
from datetime import datetime
from supabase_load import load_cfg, req, user_id


def who(row):
    """Which client made the change, from the writer header the trigger kept."""
    w = (row.get('writer') or '').lower()
    if 'supabase-swift' in w:
        return 'iPhone app'
    if 'supabase-js-web' in w:
        return 'web app'
    if w.startswith('tool:'):
        return w[5:]
    if 'python' in w or row.get('role') == 'service_role':
        return 'server job'
    return w.split('/')[0] or '?'


def when(stamp):
    """A Postgres timestamp in the Mac's local time, e.g. "Tue 3 Nov 19:26"."""
    t = datetime.fromisoformat(re.sub(r'\.\d+', '', stamp).replace('Z', '+00:00'))
    return t.astimezone().strftime('%a %-d %b %H:%M:%S')


def short(v, width=70):
    s = '—' if v is None else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= width else s[:width - 1] + '…'


class History:
    def __init__(self):
        cfg = load_cfg()
        self.key, self.base, self.uid = cfg['service_key'], cfg['url'] + '/rest/v1/', user_id(cfg)

    def get(self, table, query):
        return req('GET', self.base + table + '?user_id=eq.' + self.uid + '&' + query, self.key)

    def changes(self, n, doc=None):
        q = 'select=hid,col,id,op,role,writer,changed_at&order=hid.desc&limit=' + str(n)
        if doc:
            col, _, id_ = doc.partition('/')
            q += '&col=eq.' + urllib.parse.quote(col) + '&id=eq.' + urllib.parse.quote(id_)
        return self.get('docs_history', q)

    def change(self, hid):
        rows = self.get('docs_history', 'hid=eq.' + str(int(hid)) + '&select=*')
        if not rows:
            sys.exit(f'No change {hid}.')
        return rows[0]

    def doc(self, col, id_):
        """The document as it is now: (data, updated_at), or (None, None) if it's gone."""
        rows = self.get('docs', 'col=eq.' + urllib.parse.quote(col) + '&id=eq.' + urllib.parse.quote(id_) + '&select=data,updated_at')
        return (rows[0]['data'], rows[0]['updated_at']) if rows else (None, None)

    def after(self, row):
        """The document just after this change: the version the next change kept, or what's there now."""
        q = ('col=eq.' + urllib.parse.quote(row['col']) + '&id=eq.' + urllib.parse.quote(row['id']) +
             '&hid=gt.' + str(row['hid']) + '&select=data&order=hid.asc&limit=1')
        nxt = self.get('docs_history', q)
        return nxt[0]['data'] if nxt else self.doc(row['col'], row['id'])[0]


def fields(before, after):
    """The top-level fields that differ (the same unit the apps' merge-on-save works in)."""
    before, after = before or {}, after or {}
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


def title(data):
    return (data or {}).get('title') or (data or {}).get('name') or ''


def list_changes(h, n, doc):
    rows = h.changes(n, doc)
    if not rows:
        print('No changes recorded yet.')
        return
    for r in rows:
        print(f"{r['hid']:>6}  {when(r['changed_at'])}  {who(r):<11} {r['op']:<6}  {r['col']}/{r['id']}")
    print('\nhistory.py show HID   to see what one change did;   history.py undo HID   to undo it')


def show(h, hid):
    r = h.change(hid)
    before, after = r['data'], h.after(r)
    print(f"Change {r['hid']}: {who(r)} {r['op']} {r['col']}/{r['id']}  {when(r['changed_at'])}")
    if title(before or after):
        print('  ' + title(before or after))
    if r['op'] == 'delete':
        print('  the document was removed')
        return r, before, after, []
    changed = fields(before, after)
    for k in changed:
        print(f'  {k}:\n    was  {short(before.get(k))}\n    then {short((after or {}).get(k))}')
    if not changed:
        print('  (no field changed)')
    return r, before, after, changed


def undo(h, hid, yes, force):
    r, before, after, changed = show(h, hid)
    now, stamp = h.doc(r['col'], r['id'])
    where = '?user_id=eq.' + h.uid + '&col=eq.' + urllib.parse.quote(r['col']) + '&id=eq.' + urllib.parse.quote(r['id'])
    if r['op'] == 'delete' or now is None:
        if now is not None:
            sys.exit('\nThe document exists again; nothing to undo.')
        plan, write = 'put the removed document back', lambda: req(
            'POST', h.base + 'docs', h.key, {'user_id': h.uid, 'col': r['col'], 'id': r['id'], 'data': before},
            {'Prefer': 'return=representation'})
    else:
        if not changed:
            sys.exit('\nNothing to undo.')
        later = [k for k in changed if now.get(k) != (after or {}).get(k)]
        if later and not force:
            sys.exit(f"\nA later change also touched {', '.join(later)}. Look with  history.py --doc {r['col']}/{r['id']}"
                     f"  and undo that first, or add --force to overwrite it.")
        data = dict(now)
        for k in changed:
            if k in before:
                data[k] = before[k]
            else:
                data.pop(k, None)
        plan = 'put back ' + ', '.join(changed) + ' (other fields stay as they are now)'

        def write():
            # Only if nobody changed it since we read it; the stamp's "+" has to be escaped in a query.
            return req('PATCH', h.base + 'docs' + where + '&updated_at=eq.' + urllib.parse.quote(stamp), h.key,
                       {'data': data}, {'Prefer': 'return=representation'})
    print(f'\nUndo will {plan}.')
    if not yes and input('Go ahead? [y/N] ').strip().lower() != 'y':
        print('Nothing changed.')
        return
    if not write():
        sys.exit('It changed again just now; nothing written. Run the same command again.')
    print('Done. The undo is in the history too:  history.py --doc ' + r['col'] + '/' + r['id'])


def main():
    args = sys.argv[1:]
    yes, force = '--yes' in args, '--force' in args
    args = [a for a in args if a not in ('--yes', '--force')]
    n, doc = 20, None
    if '-n' in args:
        i = args.index('-n'); n = int(args[i + 1]); del args[i:i + 2]
    if '--doc' in args:
        i = args.index('--doc'); doc = args[i + 1]; del args[i:i + 2]
    h = History()
    if not args:
        list_changes(h, n, doc)
    elif args[0] == 'show' and len(args) == 2:
        show(h, args[1])
    elif args[0] == 'undo' and len(args) == 2:
        undo(h, args[1], yes, force)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
