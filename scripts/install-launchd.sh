#!/bin/sh
# Optional: start the Taskboard server at login with launchd. Run this once to install; remove with
#   launchctl bootout gui/$(id -u)/com.taskboard.server && rm ~/Library/LaunchAgents/com.taskboard.server.plist
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(dirname "$(command -v node)")"
PLIST="$HOME/Library/LaunchAgents/com.taskboard.server.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.taskboard"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.taskboard.server</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array><string>$DIR/node_modules/.bin/tsx</string><string>server/index.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.taskboard/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/.taskboard/server.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.taskboard.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Taskboard starts at login; log in ~/.taskboard/server.log"
