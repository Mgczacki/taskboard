#!/bin/sh
# Run the real Taskboard as a macOS login service: launchd starts it at login and starts it again within ~10 s if it
# stops for any reason. It runs the current release (~/.taskboard/app, made by `pnpm release`), never a checkout.
# Remove with:
#   launchctl bootout gui/$(id -u)/com.taskboard.server && rm ~/Library/LaunchAgents/com.taskboard.server.plist
set -e
APP="$HOME/.taskboard/app"
[ -e "$APP/server/index.ts" ] || { echo "No release yet: run 'pnpm release' in the Taskboard checkout first."; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"
PLIST="$HOME/Library/LaunchAgents/com.taskboard.server.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.taskboard.server</string>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>ProgramArguments</key><array><string>$APP/node_modules/.bin/tsx</string><string>server/index.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>LANG</key><string>en_US.UTF-8</string><key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.taskboard/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/.taskboard/server.log</string>
</dict></plist>
PL
# a server started by hand would hold the lock; stop it so launchd's copy can start
if [ -f "$HOME/.taskboard/server.pid" ]; then kill "$(python3 -c "import json;print(json.load(open('$HOME/.taskboard/server.pid'))['pid'])")" 2>/dev/null || true; sleep 2; fi
launchctl bootout "gui/$(id -u)/com.taskboard.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Taskboard starts at login and restarts by itself; log in ~/.taskboard/server.log"
