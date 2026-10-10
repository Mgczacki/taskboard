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
- `tb restart` or `scripts/restart.mjs` against the real Taskboard. Only the user restarts it. Test the restart on a sandbox.

A PreToolUse hook blocks most of these for Claude Code sessions started by Taskboard. Do not work around it.
If a command fails under agent permissions, use `tb suggest "<command>" --why "<reason>" --risk "<risk>"`.
Do not ask the user to copy a command from chat.

## Test servers
Use `pnpm sandbox` (own port, folders and tmux socket, no controller; `pnpm sandbox stop` ends exactly it) or
`pnpm dev` for live reload. A release changes the real Taskboard. Only the user decides when to release it.

When the user explicitly asks for a release or rebuild, the controller starts a task with `tb new`.
The task prompt states that the user explicitly authorized the release. The controller never starts a release on its own.
The task runs `tb release-request`, or `tb release-request --ref <branch>` to release a branch. The user approves the
release card on the dashboard. The controller can also approve that card on the user's direct request, when Settings permits it.
A task cannot approve its own card. `tb release-request` prints the card ID and returns while the card waits.
Run `tb release-result <card> --wait` to read the decision. An approved card authorizes its exact release command.
Run that command immediately. Do not ask for the same approval again or wait for the permit to expire.
The controller can convey the user's direct release instruction through `tb send`. That message does not replace the card. The approval is valid for five minutes, for one command, for that
task and that ref. Run the approved command alone on the command line:
- `pnpm release` (the files of the checkout), or `pnpm release --ref <branch>`
- either one with `--no-switch` (build and check only)

The guard refuses `;`, `&&`, `||`, `|`, backticks, `$( )`, quotes, redirects and other script paths in that line.
If the guard blocks a command, stop and tell the user what the guard said. Do not try another way to run it.
Read the release and rollback scripts with the Read tool, or with `cat`, `head`, `tail` or `grep` alone or joined with `|`.
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
