# Working on Taskboard from inside Taskboard

You are probably running as a Taskboard task. The Taskboard server on this machine (port 4317, `~/.taskboard`,
tmux socket `taskboard`) runs you, the other agents and the controller. If it stops, every agent loses its status
updates and the user loses the dashboard. Never stop, restart or rebuild it as part of your work. The user does that.

## Never
- `pkill` / `killall` by name (`tsx`, `node`, `server/index.ts`, `taskboard`): it can match the real server.
- `kill` the process in `~/.taskboard/server.pid`, or whatever listens on port 4317.
- `tmux -L taskboard kill-server` or `kill-session` on that socket: it holds the real agents.
- `pnpm start` in a checkout: it refuses (the real Taskboard runs from a release in `~/.taskboard/releases`).
- `pnpm rollback`, or any direct change to `~/.taskboard` (the real server's folder).
- `pnpm release` without a release permit from the user's dashboard approval.
- `launchctl` commands for `com.taskboard.server`.

A PreToolUse hook blocks most of these for Claude Code sessions started by Taskboard. Do not work around it.
If a command fails under agent permissions, use `tb suggest "<command>" --why "<reason>" --risk "<risk>"`.
Do not ask the user to copy a command from chat.

## Test servers
Use `pnpm sandbox` (own port, folders and tmux socket, no controller; `pnpm sandbox stop` ends exactly it) or
`pnpm dev` for live reload. A release changes the real Taskboard. Only the user decides when to release it.

When the user explicitly asks for a release or rebuild, the controller starts a task with `tb new`.
The task prompt states that the user explicitly authorized the release. The controller never starts a release on its own.
The task runs `tb release-request`. The user approves the release card on the dashboard.
The task then runs `pnpm release` within two minutes. The approval allows one release command for that task.
Only the user runs `pnpm rollback`.

The manual steps below start a test server with its own port, folders and tmux socket.
Stop the test server with its own process id.

```sh
S=<your scratch folder>; mkdir -p $S/vault $S/tbdir
TASKBOARD_PORT=4399 TASKBOARD_VAULT=$S/vault TASKBOARD_DIR=$S/tbdir TASKBOARD_TMUX_SOCKET=tbtest \
  npx tsx server/index.ts > $S/server.log 2>&1 & PID=$!
# ... test against http://127.0.0.1:4399 with the token in $S/tbdir/token ...
kill $PID; tmux -L tbtest kill-server
```

`TASKBOARD_DIR=$S/tbdir pnpm stop` also stops exactly that server (it reads `$S/tbdir/server.pid`).
Set `TASKBOARD_MACHINE_NAME=test` and write `{"controller":{"autostart":false}}` to `$S/tbdir/machine.json` first
if the test does not need a controller (otherwise the test server starts one, with Remote Control).

## Layout
- `server/` Express + ws server run with `tsx` (no build step); `server/index.ts` is the entry point.
- `web/` React + Vite interface, built into `web/dist` with `pnpm build`.
- `bin/tb` the command-line tool agents use. `server/hooks/` scripts the CLIs run (hooks, status line, notify, guard).
- `pnpm typecheck` must pass before you commit.
