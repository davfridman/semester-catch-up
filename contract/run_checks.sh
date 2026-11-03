#!/bin/sh
# Every contract check that needs no data and no credentials: the web rules, merge-on-save, the Python rules, and the schemas
# with their synthetic fixtures. Needs node and python3 (stdlib only). Exits non-zero if any check fails.
#   sh contract/run_checks.sh
set -e
cd "$(dirname "$0")/.."
for f in *.js features/*.js; do [ -f "$f" ] && node --check "$f"; done
node contract/check_web.mjs
node contract/check_sync.mjs
python3 tools/contract_rules.py
python3 tools/contract_check.py --self-test
python3 tools/contract_check.py contract/fixtures/docs.json
echo "All contract checks pass."
