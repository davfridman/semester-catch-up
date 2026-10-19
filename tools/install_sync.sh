#!/bin/zsh
# Installs the daily Moodle sync as a macOS launch agent. Re-run after changing the tools.
# The tools are copied out of ~/Desktop because macOS blocks background jobs from reading it.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/Library/Application Support/semester-catchup"
mkdir -p "$DST/tools"
cp "$SRC/moodle_sync.py" "$SRC/supabase_load.py" "$SRC/daily_sync.sh" "$DST/tools/"
P="$HOME/Library/LaunchAgents/com.davfridman.semester-sync.plist"
cat > "$P" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.davfridman.semester-sync</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$DST/tools/daily_sync.sh</string></array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/semester-sync.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/semester-sync.log</string>
</dict>
</plist>
PLIST
plutil -lint "$P" >/dev/null
launchctl bootout "gui/$(id -u)/com.davfridman.semester-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$P"
echo "Installed: runs at 07:00 and 19:00. Log: ~/Library/Logs/semester-sync.log"
