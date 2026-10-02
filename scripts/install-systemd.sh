#!/bin/sh
# Linux: run the real Taskboard as a systemd user service (the equivalent of scripts/install-launchd.sh on a Mac).
# systemd starts it when you log in and starts it again 10 s after it stops. To start it at boot without a login,
# run once: loginctl enable-linger "$USER" (this script does not run it).
#
# Same steps and rules as install-launchd.sh: checks that change nothing (not root, systemctl --user answers, the
# release and node exist), the launcher ~/.taskboard/bin/taskboard-server (a link to node: on Linux the process name
# is the name of the file that was started, so ps and top show taskboard-server), the unit written to a temporary
# file and checked with systemd-analyze verify when it exists, the old service stopped and waited for, the new unit
# moved into place, enabled and started with retries, and a check that http://127.0.0.1:<port>/api/info answers within
# 30 s. A failure after the stop puts the previous unit back and starts it. It is safe to run again: with no change it
# only checks the server. --force reinstalls. The last line is the result; the exit code is 0 only on success.
#
# Remove with: systemctl --user disable --now taskboard.service && rm ~/.config/systemd/user/taskboard.service
# Tests set: TB_SYSTEMD_UNIT (a test unit name needs its own TASKBOARD_DIR), TB_SYSTEMD_DIR, TASKBOARD_DIR,
# TASKBOARD_PORT, TASKBOARD_VAULT, TASKBOARD_TMUX_SOCKET, TASKBOARD_MACHINE_NAME, TB_INSTALL_WAIT_UP, TB_INSTALL_TRIES.
set -u
REAL_UNIT=taskboard
UNIT=${TB_SYSTEMD_UNIT:-$REAL_UNIT}
TB=${TASKBOARD_DIR:-$HOME/.taskboard}
PORT=${TASKBOARD_PORT:-4317}
UNITS=${TB_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
WAIT_UP=${TB_INSTALL_WAIT_UP:-30}
TRIES=${TB_INSTALL_TRIES:-5}
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
APP=$TB/app
FILE=$UNITS/$UNIT.service
LAUNCHER=$TB/bin/taskboard-server
URL=http://127.0.0.1:$PORT/api/info

fail() { line="Not installed: $1"; [ -n "${2:-}" ] && line="$line Next step: $2"; echo "$line"; exit 1; }
sc() { systemctl --user "$@"; }
answers() { [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$URL" 2>/dev/null)" = 200 ]; }
wait_up() { n=0; while ! answers; do n=$((n + 1)); [ $n -gt "$WAIT_UP" ] && return 1; sleep 1; done; return 0; }
start() { i=1; pause=1; while [ $i -le "$TRIES" ]; do START_ERR=$(sc enable --now "$UNIT.service" 2>&1) && return 0; sleep $pause; i=$((i + 1)); pause=$((pause * 2 > 4 ? 4 : pause * 2)); done; return 1; }
wait_stopped() { n=0; while sc is-active --quiet "$UNIT.service"; do n=$((n + 1)); [ $n -gt 80 ] && return 1; sleep 0.25; done; return 0; }

if [ -n "${TASKBOARD_DIR:-}" ] && [ "$UNIT" = "$REAL_UNIT" ]; then fail "TASKBOARD_DIR is set, so this is a test install, but the unit is the real $REAL_UNIT." "Set TB_SYSTEMD_UNIT to a test name."; fi
if [ -z "${TASKBOARD_DIR:-}" ] && [ "$UNIT" != "$REAL_UNIT" ]; then fail "a test unit ($UNIT) needs its own TASKBOARD_DIR." ""; fi
if [ -n "${TASK_ID:-}" ] && [ "$UNIT" = "$REAL_UNIT" ]; then fail "this runs inside a Taskboard task (TASK_ID is set). Only the user installs the real service." ""; fi
[ "$(id -u)" = 0 ] && fail "this runs as root. The service belongs to your user." "Run it again without sudo."
command -v systemctl >/dev/null 2>&1 || fail "systemctl is not on PATH. This script is for Linux with systemd." ""
sc show-environment >/dev/null 2>&1 || fail "systemctl --user cannot reach your user manager (no login session, or a container without systemd)." "Run it in a terminal of your desktop session, or after 'loginctl enable-linger $USER'."
[ -e "$APP/server/index.ts" ] || fail "no release at $APP." "Run 'pnpm release' in the Taskboard checkout first."
NODE=$(command -v node) || fail "node is not on PATH." ""

mkdir -p "$TB/bin" "$UNITS" || fail "cannot create $TB/bin or $UNITS." ""
LAUNCHER_CHANGED=0
if [ "$(readlink "$LAUNCHER" 2>/dev/null)" != "$NODE" ]; then ln -sfn "$NODE" "$LAUNCHER.new" && mv -f "$LAUNCHER.new" "$LAUNCHER" || fail "cannot write $LAUNCHER." ""; LAUNCHER_CHANGED=1; fi

envs=""
for v in TASKBOARD_DIR TASKBOARD_PORT TASKBOARD_VAULT TASKBOARD_TMUX_SOCKET TASKBOARD_MACHINE_NAME; do
  eval "val=\${$v:-}"; [ -n "$val" ] && envs="${envs}Environment=\"$v=$val\"
"
done
NEW=$FILE.new.$$
cat > "$NEW" <<UNIT
[Unit]
Description=Taskboard Server
After=network.target

[Service]
WorkingDirectory=$APP
ExecStart="$LAUNCHER" --import tsx server/index.ts
Environment="LANG=en_US.UTF-8"
Environment="PATH=$(dirname "$NODE"):/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin"
${envs}Restart=always
RestartSec=10
StandardOutput=append:$TB/server.log
StandardError=append:$TB/server.log

[Install]
WantedBy=default.target
UNIT
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$NEW" >/dev/null 2>&1 || { err=$(systemd-analyze --user verify "$NEW" 2>&1 | head -n 1); rm -f "$NEW"; fail "the new unit is not valid ($err)." "Report this as a bug."; }
fi

if [ $FORCE = 0 ] && [ $LAUNCHER_CHANGED = 0 ] && cmp -s "$NEW" "$FILE" && sc is-active --quiet "$UNIT.service"; then
  rm -f "$NEW"
  if wait_up; then echo "Installed and running: no change was needed. $URL answers. Log: $TB/server.log"; exit 0; fi
  fail "the service runs but the server does not answer on $URL." "Read $TB/server.log, or run this script with --force."
fi

HAD_OLD=0; PREV=$(mktemp); [ -f "$FILE" ] && { cp -p "$FILE" "$PREV"; HAD_OLD=1; }
restore() {
  if [ $HAD_OLD = 1 ]; then cp -p "$PREV" "$FILE.restore.$$" && mv -f "$FILE.restore.$$" "$FILE"; sc daemon-reload
    if start; then echo "The previous service was put back and started again."; else echo "The previous unit was put back, but it did not start either ($START_ERR)."; fi
  else echo "There was no previous service to put back."; fi
}
sc stop "$UNIT.service" >/dev/null 2>&1
wait_stopped || { rm -f "$NEW"; fail "the old service did not stop within 20 s." "Run this script again in a minute."; }
mv -f "$NEW" "$FILE" || { rm -f "$NEW"; echo "$(restore)"; fail "cannot write $FILE." ""; }
sc daemon-reload
if ! start; then err=$START_ERR; echo "$(restore)"; fail "systemctl --user enable --now failed $TRIES times: $(echo "$err" | head -n 1)" "Run: journalctl --user -u $UNIT -n 50"; fi
if ! wait_up; then
  echo "The server did not answer on $URL within $WAIT_UP s. Last lines of $TB/server.log:"; tail -n 8 "$TB/server.log" 2>/dev/null | sed 's/^/    /'
  sc stop "$UNIT.service" >/dev/null 2>&1; echo "$(restore)"
  fail "the new service started, but the server did not answer within $WAIT_UP s." "Read $TB/server.log, fix the cause, and run this script again."
fi
rm -f "$PREV"
echo "Installed and running: systemd starts Taskboard Server at login and restarts it if it stops. $URL answers. Log: $TB/server.log"
