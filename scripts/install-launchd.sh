#!/bin/sh
# Run the real Taskboard as a macOS login service: launchd starts it at login and starts it again within 10 s if it
# stops for any reason. It runs the current release (~/.taskboard/app, made by `pnpm release`), never a checkout.
#
# Run it in Terminal, as yourself (not with sudo). It is safe to run again: when the service already runs this
# release with the same settings, it changes nothing and only checks that the server answers. --force reinstalls.
#
# Steps, and what each failure does:
#  1. Checks that nothing is changed by: not root, launchctl reaches gui/<uid>, the release and node exist, and a
#     throwaway probe service (in a temporary folder, so System Settings does not list it) can be loaded and removed.
#     A sandboxed shell (for example an agent's) fails the probe and the script stops here.
#  2. Makes the launcher ~/.taskboard/Taskboard Server.app: a copy of node with that name, so Activity Monitor, top
#     and Background Items in System Settings show "Taskboard Server" and not node or tsx (cp -c: an APFS clone).
#  3. Writes the new plist to a temporary file next to the old one and checks it with plutil -lint.
#  4. Stops the old server: removes the loaded service and waits until launchctl print no longer finds it (bootout
#     returns before launchd has finished; an immediate bootstrap then fails with "5: Input/output error"), then
#     stops a server started by hand (the pid in server.pid, if that process runs server/index.ts).
#  5. Moves the new plist into place (rename), enables the label (a disabled label does not load at login), and loads
#     it with up to 5 tries and a growing pause.
#  6. Waits up to 30 s for http://127.0.0.1:<port>/ to answer.
#  If step 5 or 6 fails, the previous plist is put back and loaded again, so a failed install never leaves the service
#  removed. The last line printed is the result; the exit code is 0 only for "Installed and running".
#
# Remove with:
#   launchctl bootout gui/$(id -u)/com.taskboard.server && rm ~/Library/LaunchAgents/com.taskboard.server.plist
#
# Tests and test installs set these (a test label must use its own TASKBOARD_DIR, and the real label must not):
#   TB_LAUNCHD_LABEL, TB_LAUNCHD_DIR (folder of the plist), TASKBOARD_DIR, TASKBOARD_PORT, TASKBOARD_VAULT,
#   TASKBOARD_TMUX_SOCKET, TASKBOARD_MACHINE_NAME, TB_INSTALL_WAIT_GONE, TB_INSTALL_WAIT_UP, TB_INSTALL_TRIES.
set -u
REAL_LABEL=com.taskboard.server
LABEL=${TB_LAUNCHD_LABEL:-$REAL_LABEL}
TB=${TASKBOARD_DIR:-$HOME/.taskboard}
PORT=${TASKBOARD_PORT:-4317}
AGENTS=${TB_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}
WAIT_GONE=${TB_INSTALL_WAIT_GONE:-20}
WAIT_UP=${TB_INSTALL_WAIT_UP:-30}
TRIES=${TB_INSTALL_TRIES:-5}
DESKTOP_BUNDLE_ID=com.taskboard.desktop   # desktop/package.json --app-bundle-id
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
APP=$TB/app
PLIST=$AGENTS/$LABEL.plist
DOMAIN=gui/$(id -u)
SERVICE=$DOMAIN/$LABEL
LAUNCHER_APP="$TB/Taskboard Server.app"
LAUNCHER="$LAUNCHER_APP/Contents/MacOS/Taskboard Server"
LOG=$TB/server.log
URL=http://127.0.0.1:$PORT/api/info
RESULT_FILE=$TB/launchd-install.json
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tb-install.XXXXXX") || { echo "Not installed: cannot create a temporary folder."; exit 1; }
trap 'rm -rf "$WORK"' EXIT

RECORD=0  # set once the checks below show that $TB is the folder this run may write
record() { # the doctor and Settings read the last result
  [ $RECORD = 1 ] || return 0
  printf '{"at":"%s","ok":%s,"label":"%s","line":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$LABEL" "$(printf '%s' "$2" | sed 's/["\\]/ /g')" > "$RESULT_FILE.tmp" 2>/dev/null && mv -f "$RESULT_FILE.tmp" "$RESULT_FILE" 2>/dev/null
  return 0
}
fail() { # fail <what happened> <next step>
  line="Not installed: $1"; [ -n "${2:-}" ] && line="$line Next step: $2"
  record false "$line"; echo "$line"; exit 1
}
loaded() { launchctl print "$SERVICE" >/dev/null 2>&1; }
answers() { [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL" 2>/dev/null)" = 200 ]; }
wait_gone() { # until launchctl print no longer finds the service; polls every 0.25 s
  n=0; while loaded; do n=$((n + 1)); [ $n -gt $((WAIT_GONE * 4)) ] && return 1; sleep 0.25; done; return 0
}
wait_up() { n=0; while ! answers; do n=$((n + 1)); [ $n -gt "$WAIT_UP" ] && return 1; sleep 1; done; return 0; }
# bootstrap with retries: a service that is still being removed, or a domain that is busy, answers "5: Input/output error"
bootstrap() { # bootstrap <plist>; sets BOOT_ERR
  i=1; pause=0.5; BOOT_ERR=
  while [ $i -le "$TRIES" ]; do
    if BOOT_ERR=$(launchctl bootstrap "$DOMAIN" "$1" 2>&1); then return 0; fi
    loaded && return 0   # another caller (or launchd itself) loaded it meanwhile
    case $BOOT_ERR in *"not permitted"*|*"not allowed"*) return 1 ;; esac
    sleep $pause; i=$((i + 1)); pause=$(awk "BEGIN{print $pause*2 > 4 ? 4 : $pause*2}")
  done
  return 1
}
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
last_log() { [ -f "$LOG" ] && tail -n 8 "$LOG" | sed 's/^/    /'; }

# ---------- 1. checks that change nothing ----------
if [ -n "${TASKBOARD_DIR:-}" ] && [ "$LABEL" = "$REAL_LABEL" ]; then fail "TASKBOARD_DIR is set, so this is a test install, but the label is the real $REAL_LABEL." "Set TB_LAUNCHD_LABEL to a test label."; fi
if [ -z "${TASKBOARD_DIR:-}" ] && [ "$LABEL" != "$REAL_LABEL" ]; then fail "a test label ($LABEL) needs its own TASKBOARD_DIR." "Set TASKBOARD_DIR, TASKBOARD_PORT, TASKBOARD_VAULT and TASKBOARD_TMUX_SOCKET for the test server."; fi
if [ -n "${TASK_ID:-}" ] && [ "$LABEL" = "$REAL_LABEL" ]; then fail "this runs inside a Taskboard task (TASK_ID is set). Only the user installs the real login service." "Ask the user to run it in Terminal, or to click Start server in the Taskboard app."; fi
RECORD=1
[ "$(id -u)" = 0 ] && fail "this runs as root (sudo). The login service belongs to your user, and root writes the wrong folder and the wrong launchd domain." "Run it again without sudo: sh scripts/install-launchd.sh"
command -v launchctl >/dev/null 2>&1 || fail "launchctl is not on PATH. This script is for macOS." ""
launchctl print "$DOMAIN" >/dev/null 2>&1 || fail "launchctl cannot reach your login session ($DOMAIN). This shell is not part of the logged-in desktop session (for example ssh, or a sandbox)." "Run it in Terminal on this Mac, or click Start server in the Taskboard app."
[ -e "$APP/server/index.ts" ] || fail "no release at $APP." "Run 'pnpm release' in the Taskboard checkout first."
[ -e "$APP/node_modules/tsx/package.json" ] || fail "the release at $APP has no node_modules/tsx." "Run 'pnpm release' again."
NODE=$(command -v node) || fail "node is not on PATH." "Install Node (for example with Homebrew) and run this again."
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
NODE_BIN=$(dirname "$(command -v node)")
PROBE_LABEL=$LABEL.probe.$$
cat > "$WORK/$PROBE_LABEL.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$PROBE_LABEL</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>
PL
if ! probe_err=$(launchctl bootstrap "$DOMAIN" "$WORK/$PROBE_LABEL.plist" 2>&1); then
  fail "launchctl may not load services from this shell ($(echo "$probe_err" | head -n 1)). Nothing was changed." "Run it in Terminal on this Mac, or click Start server in the Taskboard app."
fi
launchctl bootout "$DOMAIN/$PROBE_LABEL" >/dev/null 2>&1

# ---------- 2. the launcher ----------
mkdir -p "$LAUNCHER_APP/Contents/MacOS" "$AGENTS" "$TB" || fail "cannot create $LAUNCHER_APP or $AGENTS." ""
cat > "$WORK/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.taskboard.server</string>
  <key>CFBundleName</key><string>Taskboard Server</string>
  <key>CFBundleDisplayName</key><string>Taskboard Server</string>
  <key>CFBundleExecutable</key><string>Taskboard Server</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
LAUNCHER_CHANGED=0
if ! cmp -s "$NODE" "$LAUNCHER" || ! cmp -s "$WORK/Info.plist" "$LAUNCHER_APP/Contents/Info.plist"; then
  # a new file renamed over the old one: a running server keeps its own copy of the old file
  cp -c "$NODE" "$LAUNCHER.new" 2>/dev/null || cp "$NODE" "$LAUNCHER.new" || fail "cannot copy $NODE to $LAUNCHER." ""
  "$LAUNCHER.new" -e 'process.exit(0)' 2>/dev/null || { rm -f "$LAUNCHER.new"; fail "the copy of node at $LAUNCHER does not run." "Check that $NODE runs."; }
  mv -f "$LAUNCHER.new" "$LAUNCHER" && cp "$WORK/Info.plist" "$LAUNCHER_APP/Contents/Info.plist" || fail "cannot write $LAUNCHER." ""
  LAUNCHER_CHANGED=1
fi

# ---------- 3. the new plist ----------
envs=""
for v in TASKBOARD_DIR TASKBOARD_PORT TASKBOARD_VAULT TASKBOARD_TMUX_SOCKET TASKBOARD_MACHINE_NAME; do
  eval "val=\${$v:-}"; [ -n "$val" ] && envs="$envs<key>$v</key><string>$(xml "$val")</string>"
done
NEW=$PLIST.new.$$
cat > "$NEW" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>AssociatedBundleIdentifiers</key><array><string>$DESKTOP_BUNDLE_ID</string></array>
  <key>WorkingDirectory</key><string>$(xml "$APP")</string>
  <key>ProgramArguments</key><array><string>$(xml "$LAUNCHER")</string><string>--import</string><string>tsx</string><string>server/index.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>LANG</key><string>en_US.UTF-8</string><key>PATH</key><string>$(xml "$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>$envs</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict></plist>
PL
cleanup_new() { rm -f "$NEW"; }
plutil -lint "$NEW" >/dev/null 2>&1 || { cleanup_new; fail "the new plist is not valid ($(plutil -lint "$NEW" 2>&1 | tail -n 1))." "Report this as a bug."; }

# Nothing changed and the service is loaded: do not restart a server that runs (or is still starting after login).
if [ $FORCE = 0 ] && [ $LAUNCHER_CHANGED = 0 ] && cmp -s "$NEW" "$PLIST" && loaded; then
  cleanup_new
  if wait_up; then record true "Installed and running (no change)."; echo "Installed and running: no change was needed. $URL answers. Log: $LOG"; exit 0; fi
  echo "The service is installed but $URL did not answer within $WAIT_UP s. Last lines of $LOG:"; last_log
  fail "the service is loaded but the server does not answer." "Run 'pnpm doctor' for the reason, or run this script with --force to reinstall."
fi

# ---------- 4. stop the old server ----------
HAD_OLD=0; [ -f "$PLIST" ] && { cp -p "$PLIST" "$WORK/previous.plist"; HAD_OLD=1; }
# the start history (server/server-life.ts) then records this stop as a restart, not as an unknown SIGTERM
printf '{"reason":"manual","at":"%s","detail":"scripts/install-launchd.sh reinstalled the login service"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TB/restart-intent.json" 2>/dev/null
if loaded; then
  launchctl bootout "$SERVICE" >/dev/null 2>&1
  wait_gone || { cleanup_new; fail "the old service was still loaded $WAIT_GONE s after launchctl bootout. It was not changed." "Run this script again in a minute."; }
fi
restore() { # put the previous plist back and load it; prints what happened
  if [ $HAD_OLD = 1 ]; then
    loaded && { launchctl bootout "$SERVICE" >/dev/null 2>&1; wait_gone; }
    cp -p "$WORK/previous.plist" "$PLIST.restore.$$" && mv -f "$PLIST.restore.$$" "$PLIST"
    if bootstrap "$PLIST"; then echo "The previous service was put back and loaded again."; else echo "The previous plist was put back, but it did not load either ($BOOT_ERR)."; fi
  else echo "There was no previous service to put back; the new one stays loaded so that launchd keeps trying."; fi
}
PIDFILE_PID=$(sed -n 's/.*"pid":[ ]*\([0-9][0-9]*\).*/\1/p' "$TB/server.pid" 2>/dev/null)
if [ -n "$PIDFILE_PID" ] && ps -o command= -p "$PIDFILE_PID" 2>/dev/null | grep -q 'server/index\.ts'; then
  kill -TERM "$PIDFILE_PID" 2>/dev/null
  n=0; while kill -0 "$PIDFILE_PID" 2>/dev/null; do n=$((n + 1)); [ $n -gt 40 ] && break; sleep 0.25; done
fi
n=0; while answers || lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; do
  n=$((n + 1))
  if [ $n -gt 20 ]; then
    holder=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (process "$2")"}')
    cleanup_new; echo "$(restore)"
    fail "port $PORT is still in use by ${holder:-another program} after the old server was stopped." "Stop that program, then run this script again."
  fi
  sleep 0.5
done

# ---------- 5. install and load ----------
mv -f "$NEW" "$PLIST" || { cleanup_new; echo "$(restore)"; fail "cannot write $PLIST." ""; }
launchctl enable "$SERVICE" >/dev/null 2>&1
if ! bootstrap "$PLIST"; then
  err=$BOOT_ERR; echo "$(restore)"
  fail "launchctl bootstrap failed $TRIES times: $(echo "$err" | head -n 1)" "Run 'pnpm doctor', or click Start server in the Taskboard app."
fi

# ---------- 6. the server answers ----------
if ! wait_up; then
  echo "The server did not answer on $URL within $WAIT_UP s. Last lines of $LOG:"; last_log
  echo "$(restore)"
  fail "the new service loaded, but the server did not answer within $WAIT_UP s." "Read $LOG, fix the cause, and run this script again."
fi
record true "Installed and running."
echo "Installed and running: launchd starts Taskboard Server at login and restarts it if it stops. $URL answers. Log: $LOG"
