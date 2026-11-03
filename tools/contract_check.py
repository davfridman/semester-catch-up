#!/usr/bin/env python3
"""Checks Supabase documents against the shared contract (contract/schema/<collection>.json).

Usage:
  contract_check.py DOCS.json     a dump: the backup's docs.json (a list of rows), or backup_dump.py's output (tables.docs)
  contract_check.py --live        the live table, read-only (credentials as in supabase_load.py)
  contract_check.py --self-test   the schemas themselves and the synthetic fixtures in contract/fixtures/ (no data, no network)
Reports each problem as collection, row id and field path only, never a value, so the output is safe to share.
Exits 1 when there are problems.

The validator understands the JSON Schema subset the contract uses: type, enum, const, pattern, minimum, maximum,
properties, required, additionalProperties, items, $ref (within the file), allOf, anyOf, oneOf, if/then/else.
Settings documents pick their schema by row id (the schema's x-documents).
"""
import collections, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, '..', 'contract')
COLS = ('course', 'item', 'settings', 'question', 'update', 'insight', 'note')
WRITERS = {'app', 'web', 'sync', 'claude', 'user-only'}
TYPES = {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'null': type(None)}


def load_schemas():
    return {c: json.load(open(os.path.join(CONTRACT, 'schema', c + '.json'))) for c in COLS}


def is_type(v, t):
    if t == 'integer':
        return isinstance(v, int) and not isinstance(v, bool) or isinstance(v, float) and v.is_integer()
    if t == 'number':
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return isinstance(v, TYPES[t])


def kind(v):
    for t in ('null', 'boolean', 'integer', 'number', 'string', 'array', 'object'):
        if is_type(v, t):
            return t


def resolve(root, ref):
    assert ref.startswith('#/'), f'only local $refs: {ref}'
    node = root
    for part in ref[2:].split('/'):
        node = node[part]
    return node


def validate(v, s, root, path, out):
    """Appends (path, problem) for every way `v` breaks schema `s`. Problems never include the value."""
    if s is True or s == {}:
        return
    if s is False:
        out.append((path, 'not allowed'))
        return
    if '$ref' in s:
        validate(v, resolve(root, s['$ref']), root, path, out)
    if 'type' in s:
        ts = s['type'] if isinstance(s['type'], list) else [s['type']]
        if not any(is_type(v, t) for t in ts):
            out.append((path, f"expected {' or '.join(ts)}, got {kind(v)}"))
            return
    if 'const' in s and v != s['const']:
        out.append((path, 'not the expected constant'))
    if 'enum' in s and v not in s['enum']:
        out.append((path, f'{kind(v)} not one of the {len(s["enum"])} allowed values'))
    if 'pattern' in s and isinstance(v, str) and not re.search(s['pattern'], v):
        out.append((path, 'does not match ' + (s.get('description') or 'the pattern').split(',')[0].split('.')[0].lower()))
    if is_type(v, 'number'):
        if 'minimum' in s and v < s['minimum'] or 'maximum' in s and v > s['maximum']:
            out.append((path, f"out of range {s.get('minimum', '')}..{s.get('maximum', '')}"))
    if isinstance(v, dict):
        for k in s.get('required', []):
            if k not in v:
                out.append((f'{path}.{k}' if path else k, 'missing'))
        props = s.get('properties', {})
        for k, x in v.items():
            p = f'{path}.{k}' if path else k
            if k in props:
                validate(x, props[k], root, p, out)
            elif 'additionalProperties' in s:
                validate(x, s['additionalProperties'], root, p, out)
    if isinstance(v, list) and 'items' in s:
        for i, x in enumerate(v):
            validate(x, s['items'], root, f'{path}[{i}]', out)
    for sub in s.get('allOf', []):
        validate(v, sub, root, path, out)
    for key in ('anyOf', 'oneOf'):
        if key in s:
            ok = 0
            for sub in s[key]:
                o = []
                validate(v, sub, root, path, o)
                ok += not o
            if not ok or key == 'oneOf' and ok > 1:
                out.append((path, 'matches none of the allowed shapes' if not ok else 'matches more than one shape'))
    if 'if' in s:
        o = []
        validate(v, s['if'], root, path, o)
        branch = s.get('then') if not o else s.get('else')
        if branch is not None:
            validate(v, branch, root, path, out)


def check_rows(rows, schemas):
    """{(col, id, path, problem)} for a list of rows {col, id, data}, plus per-collection row counts."""
    problems, counts = [], collections.Counter()
    for r in rows:
        col, rid, data = r.get('col'), r.get('id'), r.get('data')
        counts[col] += 1
        if col not in schemas:
            problems.append((col, rid, '', 'collection not in the contract'))
            continue
        if not isinstance(data, dict):
            problems.append((col, rid, '', f'data is {kind(data)}, not an object'))
            continue
        root = schemas[col]
        out = []
        validate(data, root, root, '', out)
        if col == 'settings':
            ref = root.get('x-documents', {}).get(rid)
            if ref:
                validate(data, resolve(root, ref), root, '', out)
            else:
                out.append(('', 'settings id not in the contract'))
        if 'id' in data and data['id'] != rid:
            out.append(('id', 'differs from the row id'))
        problems += [(col, rid, p, m) for p, m in out]
    return problems, counts


def report(problems, counts, label):
    n_docs = sum(counts.values())
    print(f'{label}: {n_docs} documents (' + ', '.join(f'{c} {counts[c]}' for c in sorted(counts, key=str)) + ')')
    if not problems:
        print('  no problems')
        return 0
    bad = {(c, i) for c, i, _, _ in problems}
    print(f'  {len(problems)} problems in {len(bad)} documents')
    # The same problem on many documents is one line, with a few of their ids.
    groups = collections.defaultdict(list)
    for c, i, p, m in problems:
        groups[(c, re.sub(r'\[\d+\]', '[]', p), m)].append(i)
    for (c, p, m), ids in sorted(groups.items(), key=lambda g: (str(g[0][0]), g[0][1])):
        more = f' and {len(ids) - 3} more' if len(ids) > 3 else ''
        print(f"  {c} {p or '(document)'}: {m} — {len(ids)}× ({', '.join(map(str, ids[:3]))}{more})")
    return 1


def dump_rows(path):
    d = json.load(open(path))
    if isinstance(d, list):
        return d
    if isinstance(d.get('tables'), dict):
        return d['tables'].get('docs') or []
    return d.get('docs') or d.get('rows') or []


def live_rows():
    from supabase_load import load_cfg, req, user_id
    cfg = load_cfg()
    uid = user_id(cfg)
    rows, off = [], 0
    while True:  # GET only: this never writes
        page = req('GET', f"{cfg['url']}/rest/v1/docs?user_id=eq.{uid}&select=col,id,data&order=col,id&limit=1000&offset={off}", cfg['service_key'])
        rows += page
        off += 1000
        if len(page) < 1000:
            return rows


def self_test(schemas):
    """The schemas are well formed and annotated, and the synthetic fixtures give exactly the expected problems."""
    fails = []

    def walk(node, path, root):
        if isinstance(node, dict):
            if '$ref' in node:
                try:
                    resolve(root, node['$ref'])
                except (KeyError, AssertionError):
                    fails.append(f'{path}: $ref {node["$ref"]} does not resolve')
            for k, v in node.items():
                walk(v, f'{path}/{k}', root)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f'{path}/{i}', root)

    def writers(props, path, nested=False):
        # Every field of a document says who may change it; a field inside an object has its parent's writers
        # unless it names its own.
        for k, p in props.items():
            w = p.get('x-writers')
            if w is None and not nested:
                fails.append(f'{path}.{k}: no x-writers')
            elif w is not None and (not set(w) <= WRITERS or 'user-only' in w and len(w) > 1):
                fails.append(f'{path}.{k}: x-writers must be from {sorted(WRITERS)}, with user-only alone')
            if 'properties' in p:
                writers(p['properties'], f'{path}.{k}', True)

    for col, s in schemas.items():
        walk(s, col, s)
        if s.get('$schema') != 'https://json-schema.org/draft/2020-12/schema':
            fails.append(f'{col}: $schema is not draft 2020-12')
        docs = [('', s)] + [(n, resolve(s, r)) for n, r in s.get('x-documents', {}).items()]
        docs += [(sub['then']['$ref'], resolve(s, sub['then']['$ref'])) for sub in s.get('allOf', []) if '$ref' in sub.get('then', {})]
        for name, d in docs:
            if d.get('additionalProperties') is not True:
                fails.append(f'{col}{name}: unknown fields must stay allowed (additionalProperties: true)')
            writers(d.get('properties', {}), col + (f'({name})' if name else ''))
    good, _ = check_rows(dump_rows(os.path.join(CONTRACT, 'fixtures', 'docs.json')), schemas)
    for p in good:
        fails.append(f'fixtures/docs.json should be clean: {p}')
    bad = json.load(open(os.path.join(CONTRACT, 'fixtures', 'docs-bad.json')))
    got, _ = check_rows(bad['rows'], schemas)
    got = {(c, i, p) for c, i, p, _ in got}
    want = {tuple(x) for x in bad['expect']}
    for x in sorted(want - got):
        fails.append(f'fixtures/docs-bad.json: expected a problem at {x}')
    for x in sorted(got - want):
        fails.append(f'fixtures/docs-bad.json: unexpected problem at {x}')
    print(f'Contract self-test: {len(schemas)} schemas, {len(want)} expected problems in docs-bad.json: ' + ('ok' if not fails else f'{len(fails)} failures'))
    for x in fails:
        print('  FAIL ' + x)
    return 1 if fails else 0


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        sys.exit(__doc__)
    schemas = load_schemas()
    if args[0] == '--self-test':
        sys.exit(self_test(schemas))
    if args[0] == '--live':
        rows, label = live_rows(), 'Live Supabase'
    else:
        rows, label = dump_rows(args[0]), os.path.basename(args[0])
    problems, counts = check_rows(rows, schemas)
    sys.exit(report(problems, counts, label))


if __name__ == '__main__':
    main()
