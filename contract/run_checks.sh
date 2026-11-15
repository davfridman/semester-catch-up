#!/bin/sh
# Every contract check that needs no data and no credentials: the web rules, merge-on-save, the Python rules, and the schemas
# with their synthetic fixtures. Needs node and python3 (stdlib only). Exits non-zero if any check fails.
#   sh contract/run_checks.sh
set -e
cd "$(dirname "$0")/.."
for f in *.js features/*.js contract/*.mjs; do node --check "$f"; done
node contract/check_web.mjs
node contract/check_sync.mjs
python3 tools/contract_rules.py
python3 tools/contract_check.py --self-test
python3 tools/contract_check.py contract/fixtures/docs.json
python3 tools/semester_setup.py --self-test
python3 -m py_compile tools/run_all.py tools/semester_setup.py tools/moodle_sync.py tools/supabase_load.py tools/shnaton.py
echo "All contract checks pass."
