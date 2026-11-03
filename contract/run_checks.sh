#!/bin/sh
# Every contract check that needs no data and no credentials: the web rules, the Python rules, and the schemas
# with their synthetic fixtures. Needs node and python3 (stdlib only). Exits non-zero if any check fails.
#   sh contract/run_checks.sh
set -e
cd "$(dirname "$0")/.."
node --check rules.js
node --check app.js
node contract/check_web.mjs
python3 tools/contract_rules.py
python3 tools/contract_check.py --self-test
python3 tools/contract_check.py contract/fixtures/docs.json
echo "All contract checks pass."
