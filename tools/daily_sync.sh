#!/bin/zsh
# Daily deadline sync, run by launchd (no Claude involved): Moodle calendar feed -> Supabase.
# Uses the newest Moodle browser snapshot too, if a Claude run saved one in the last 3 days.
cd "$(dirname "$0")/.."
SNAP="$HOME/.config/semester-catchup/moodle-latest.json"
ARGS=()
if [[ -f "$SNAP" && -n $(find "$SNAP" -mtime -3 2>/dev/null) ]]; then ARGS=(--moodle "$SNAP"); fi
echo "=== $(date '+%Y-%m-%d %H:%M') ==="
/Library/Frameworks/Python.framework/Versions/3.8/bin/python3 tools/moodle_sync.py "${ARGS[@]}"
