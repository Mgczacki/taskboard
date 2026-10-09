# Taskboard

A local board for many Claude Code and Codex agents. Each agent runs unmodified in its own tmux session;
Taskboard shows what each one is doing, which ones need you, and lets you open any of them as a live terminal.

## New team members

Start with [Set up Taskboard on your Mac](SETUP.md). It covers installation and your first task.

The guide also explains messages with other people through A2A Notes (https://github.com/Mgczacki/a2a-notes) over Slack.

## Install (from this repository)

Requirements: macOS, [Homebrew](https://brew.sh), and Claude Code and/or Codex installed and signed in.

```sh
brew install node pnpm tmux                       # Node 20.19+ recommended (22 LTS is fine)
git clone https://github.com/Mgczacki/taskboard.git ~/taskboard
cd ~/taskboard
pnpm install
pnpm release                                      # build a release and start the server on http://127.0.0.1:4317
sh scripts/install-launchd.sh                     # keep the server running: starts at login, restarts if it stops
pnpm app                                          # build the Mac app and install it as ~/Applications/Taskboard.app
mkdir -p ~/.local/bin && ln -sfn ~/.taskboard/bin/tb ~/.local/bin/tb   # the `tb` command for you and the agents
```

Then open **Taskboard** from Spotlight, Raycast, Launchpad or `~/Applications` (drag it to the Dock to keep it there).
The browser works too: <http://127.0.0.1:4317>.

- **Update:** `git pull && pnpm install && pnpm release` (the server), and `pnpm app` (the Mac app, if `desktop/` changed).
- **Is it installed? Why does it not start?** `pnpm doctor` in the checkout prints the state of the server and of the
  login service (installed, loaded, crashed with the last log lines, port used by another program, no release) and the
  step that repairs it. `pnpm doctor --repair` runs that step. The Mac app shows the same check on its waiting page,
  with a **Start server** button, and in its menu-bar item.
- `pnpm app` downloads Electron from its GitHub releases and checks it against the published SHA-256 sums (Electron's
  own installer needs Node 22.12+, so the build does this itself on older Node).

## Run it

The real Taskboard runs from a **release**: a frozen copy of the code in `~/.taskboard/releases/<id>`, reached through
the link `~/.taskboard/app`. The checkout `~/taskboard` (where you and agents change the code) never runs as the real
server. It refuses to. launchd starts the release at login and restarts it within seconds if it stops.

```sh
cd ~/taskboard
pnpm install
pnpm release                     # copy → install → typecheck → build → start check → switch → restart
sh scripts/install-launchd.sh    # once: run the release as a login service that restarts by itself
```

`scripts/install-launchd.sh` runs in Terminal, as you (not with sudo). It refuses to run where launchctl cannot load
services (ssh, an agent's sandbox), and changes nothing then. It waits until the old service is removed before it
loads the new one, retries the load, checks that the server answers within 30 s, and puts the previous service back if
any step fails. It is safe to run again: when nothing changed it only checks the server. Its last line is the result.
It runs the server as `~/.taskboard/Taskboard Server.app` (a copy of node with that name), so Activity Monitor, top and
System Settings → General → Login Items show **Taskboard Server** instead of node or tsx. Run it once again after
each update of Node.

On Linux, `scripts/install-systemd.sh` does the same with a systemd user service (`taskboard.service`). Run
`loginctl enable-linger $USER` once if the server must start at boot without a login. On Windows, a task in Task
Scheduler that runs at logon is the equivalent; there is no script for it yet.

- **Update:** `pnpm release` again. If the new release does not answer within 30 s, it switches back by itself.
  `pnpm release --ref <commit>` releases a commit instead of the current files; `--no-switch` only builds and checks.
- **Go back:** `pnpm rollback` (the release before) or `pnpm rollback <id>`; `pnpm rollback --list` shows them.
- **Try code without touching the real one:** `pnpm sandbox` starts the current folder's code on its own port, folders
  (in the system temp folder) and tmux socket, without a controller, and prints its address. Its pages show an orange
  "Sandbox" bar. `pnpm sandbox stop [--clean]`, `pnpm sandbox list`. `pnpm dev` is a sandbox that restarts on code
  changes, with the Vite interface.
- **Restart the real one:** `~/.taskboard/bin/tb restart` in a terminal, or **Settings → Taskboard server → Restart
  Taskboard** on the dashboard. It starts the installed release again and builds nothing. It first prints what a
  restart does to running tasks and asks for confirmation when work would stop (for example a running BTW answer). It
  checks that the installed code starts, restarts the server (with launchd: `launchctl kickstart -k`), and waits until
  the new server answers. If the new server does not answer, it prints the error and `~/.taskboard/server.log`.
  `--yes` skips the question. The controller's `tb restart` puts an Approve card on the dashboard. Tasks cannot restart.
- **Stop the real one:** without the login service, `pnpm stop` stops exactly the process in `~/.taskboard/server.pid`.
  Never use `pkill -f` patterns. Agents keep running in tmux in every case and reconnect when the server is back.
- **Remove the login service:** `launchctl bootout gui/$(id -u)/com.taskboard.server && rm ~/Library/LaunchAgents/com.taskboard.server.plist`
- **Log:** `~/.taskboard/server.log` (it says when and why the server stopped).
- **Find Taskboard's processes:** `tb top` prints every process of Taskboard grouped by task, with CPU, memory, energy
  impact and age; **Settings → Taskboard server → Processes** shows the same table. Each agent starts as
  `tb#<task number> <agent>` (the controller as `tb#controller <agent>`):
  - `ps -ax -o pid,pcpu,rss,args | grep 'tb#'`, or `pgrep -fl 'tb#'`
  - htop: F4 (filter) and type `tb#`. htop shows the command line, so the name is visible.
  - top: `top -pid <pid>`. top and Activity Monitor show the program file name (`2.1.288` for Claude Code, `codex`),
    not `tb#`. Use `tb top` for these.
  - by environment: `ps -wwE -o pid,args -p <pid> | grep -o 'TASK_ID=[^ ]*'` names the task of any process an agent
    started, also one whose parent ended.
  - Activity Monitor → Energy groups all of Taskboard's processes (server, tmux, agents, task browsers) under
    **Taskboard Server**, because they share the server's coalition.
- **Open an agent from a normal terminal:** `tmux -L taskboard attach -t task-<number>` (the task panel has a copy button).
- **Node:** Node 20.19 or newer is recommended. On 20.18 pnpm skips Vite's native bundler unless installing with
  `--force` (the release script does that).

## Mac app

`desktop/` is an Electron app (installed as `~/Applications/Taskboard.app`) that shows the dashboard in its own
window. It contains no server: the server keeps running under launchd, and quitting the app stops nothing.

- Dock badge and menu-bar item with the number of tasks waiting on you. The menu lists them (click one to open it),
  plus Triage and Controller.
- Control-Option-Command-T shows or hides the window from any app (change `shortcut` in
  `~/Library/Application Support/taskboard-desktop/settings.json`).
- Closing the main window only hides it; ⌘Q quits the app.
- Every open window restores its position and size after the app closes or restarts.
  It also restores the page and open task panel. The app opens at login by default
  (turn it off with "Open at login" in the menu-bar menu). The list is kept in
  `~/Library/Application Support/taskboard-desktop/settings.json`.
- No title bar: the window buttons appear when the pointer is near the top edge. Drag the window by its top bar or
  the top of the sidebar.
- File → New Task (⌘T) opens the New task dialog, also while a terminal has the keyboard (in a browser, use ⌃⌥T).
- New windows: File → New Window (⌘N), New Window for Group (one canvas tab on its own), New Canvas Window (⇧⌘N);
  the same in the Dock icon's right-click menu and the menu-bar item. Window lists all open windows.
- Taskboard's own shortcuts (⌘K, ⌘S, ⌘/, ⌃⌥ keys) reach the page. Pop-out group windows open as app windows. Links to
  other sites open in your browser. While the server does not answer, a waiting page reconnects by itself.
- Rebuild and reinstall: `pnpm app` (or `cd desktop && pnpm build && pnpm install-app`). (Electron's own download script needs
  Node 22. On Node 20 the Electron binary was downloaded by hand and checked against its published SHA-256.)

## Developing Taskboard inside Taskboard

Agents that work on Taskboard itself run inside the real one, so the setup keeps the two apart:

- The real server runs a release copy, so editing, rebuilding or breaking `~/taskboard` changes nothing that runs.
- Only you release, roll back or restart (the agents' guard blocks `pnpm release`, `pnpm rollback` and `tb restart`).
  When you ask a task for a release, the task runs `tb release-request` (or `tb release-request --ref master`).
  You approve the card on the dashboard. The approval writes a permit for that task and that ref, valid for five
  minutes. The task then runs `pnpm release` (or `pnpm release --ref master`, also with `--no-switch`) alone on the
  command line. The guard deletes the permit when it lets the command run, so one approval allows one command. A
  task can read the release scripts with `cat`, `head`, `tail`, `grep` and similar commands that only read.
- Every test copy is a sandbox with its own port, folders and tmux socket. A sandbox refuses to start on the real
  port, `~/.taskboard`, `~/AgentVault` or the `taskboard` tmux socket.
- One server per `~/.taskboard` (an exclusive lock file). A second one exits with a message.
- A PreToolUse hook (`server/hooks/guard.mjs`) blocks Claude Code agents from stopping the real server or its tmux
  sessions, deleting `~/.taskboard`, or releasing (Codex has no such hook. The other rules still apply to it).
- If the server stops anyway, launchd starts it again, and the agents never depended on it (they run in tmux).
- Instructions for agents: `CLAUDE.md` / `AGENTS.md` in the repository.

## Pages and keys

| Page | What it is |
|---|---|
| List | Every task grouped by status, or by linked set (indented by Depends on or Started by), with Goal / Now / Waiting. Tick tasks to group them or open them together. |
| Board | Columns by status, or by group (drag a card onto a group to add it. Hold ⌥ to move it). |
| Graph | Tasks in lanes (group, folder, status or links). Arrows show documents sent from one task to another, and links between tasks. |
| Canvas | Live terminals. Tabs across the top are your groups. Columns / Grid / Rows. Ports on each title bar show task links. |
| Inbox | Messages with other people (A2A Notes), notes from your tasks, and documents to review. The Sent tab shows drafts and sent messages. |
| Accounts | Settings folders per account, sign-in, limit marks, and limit resets (only you can use them). |

Keys (press `⌘/` in the app for the full list; change them on the Settings page): `⌘K` or `⌃⌥K` controller, also from inside
a terminal · `⌘T` (Mac app) or `⌃⌥T` new task · `⌃⌥Q` triage (everything waiting on you, longest first) · `⌃⌥U` canvas view Needs you + unread · `⌘S` hide the sidebar.
Every default key has ⌘, ⌃ or ⌥ in it, so typing a letter never runs a shortcut. Keys with ⌘ or ⌃ work everywhere, also inside a terminal.
You can add a single-letter key on the Settings page. It works only when the cursor is not in a terminal, a text field or the task browser.
Review page: `⌃⌥↓` / `⌃⌥↑` next / previous document, `⌃⌥C` comment on the selected text, `⌃⌥A` accept, `⌘↩` send. Graph page: `⌃⌥F` fits the graph.
Task browser: while the focus is in it, every key goes to the page, also ⌘ and ⌃ keys. `⌃⌥Esc` gives the keys back to Taskboard.
`⌘C` copies the selected text of the page, and `⌘V` pastes into it. On the canvas: `⌃⌥←→` focus, `⌃⌥↩` maximize, `⌃⌥L` layout, `⌃⌥F` focus mode (Esc or the button
bottom-right exits), `⌃⌥G` / `⌃⌥⇥` / `⌘⇧]` next view, `⌃⌥⇧⇥` / `⌘⇧[` previous view, `⌃⌥⇧G` new group, `⌃⌥N` next waiting, `⌃⌥.` / `⌃⌥,` text size, `⌃⌥W` remove window, `⌃⌥⇧,` / `⌃⌥⇧.` move the focused window one place left / right, `⌃⌥PageUp` / `⌃⌥PageDown` (or `⌃⌥[` / `⌃⌥]`) previous / next page.
A sideways swipe (or Shift + wheel) over a terminal scrolls the canvas, or turns one page when **Per page** is on.
**Per page** sets the most tiles on a page. Tiles grow to fill a page with fewer tasks in Columns, Grid, and Rows.
⌘-click window headers or cards to select several. Drag a window header onto a group tab to add it.
Drag a window header (the ⠿ handle) between two windows to move it there. A blue bar shows the drop position.
A group view keeps that order in the group's task list. The other views keep it in `~/.taskboard/canvas-order.json`.
A move between windows never changes a task's groups. A new task goes after the windows that you moved.

## How it works

- **Agents run in tmux** on a separate tmux server (`tmux -L taskboard`). Closing a terminal in Taskboard only detaches.
- **Status comes from the agents' own events:**
  - Claude Code hooks, passed per session with `claude --settings ~/.taskboard/claude-settings.json`: prompt → working,
    permission request → needs you (with the exact command), finished turn → done · unread (its last message is "Now"),
    API error such as a rate limit → stopped (and the account is marked as at its limit).
  - Codex: a `notify` program passed with `codex -c notify=[…]` reports finished turns (your own notify program is
    still called). A change to Codex's transcript file after a finished turn means it is working again.
  - Questions that appear before any hook can fire (trust this folder, update available, sign in) are read from the
    screen during the first 90 seconds.
- **Your global Claude Code and Codex settings are not changed.**
- **Task instructions:** Claude Code tasks get them with `--append-system-prompt`. Codex tasks get the same text with
  `-c developer_instructions=…`, except that Codex is told Taskboard copies the first paragraph of its last reply into `log.md`.
- **Plain English rules:** every agent's instructions and the controller's `CLAUDE.md` / `AGENTS.md` tell it to write
  log entries, outbox documents, artifacts and messages with the ASD-STE100 writing rules. The full rules and a word
  scan are in `writing/` (from the `kiss` skill in sekai-superhuman-knowledge). The server copies them to
  `~/AgentVault/docs/` at start, where agents read them without a permission prompt.
- **Tasks are Markdown notes** in `~/AgentVault/tasks/<id>.md`. Each task folder has `log.md` (Did / Waiting / Next per
  turn. The Stop hook asks once if the agent forgot), `terminal.log` (all output), `outbox/` and `inbox/`.
- **Inbox / outbox:** agents save documents (Markdown or HTML) in their `outbox/`. Sending copies a file into another
  task's `inbox/`; Claude Code is told on its next prompt, Codex through "Tell the agent now". HTML opens in a floating
  preview (sandboxed) or in the browser.
- **tmux listing:** tmux is always run with a UTF-8 locale and its session list uses a printable separator. A task
  is only marked Suspended after tmux confirms its session is gone, and a Suspended task whose session is running
  goes back to its status by itself.
- **Terminals:** tmux mouse mode is on, so the mouse wheel scrolls: Claude Code scrolls its own view, and Codex (started
  with `--no-alt-screen`) scrolls through tmux's history. Drag to select copies to the clipboard; ⌥-drag selects directly.
  Terminals draw with WebGL, and output is sent in batches every 8 ms.
- **Answers:** The task panel's Answers tab lists short answers to questions sent from the dashboard, including a new
  task's first prompt. Open an answer to see its question, answer, and time. Jump to question or Jump to answer opens
  the matching transcript record.
  Taskboard stores the question and short answer in `answer-history.json` beside the task. It keeps the agent's full
  transcript in the agent's own session file. An unanswered question does not appear in the list.
- **Managing tasks:** select tasks with their checkboxes (list) or ⌘-click (board, canvas), then use the bar at the bottom:
  Set aside, End & archive, Remove. **Set aside** takes a task off Needs you / Unread / triage without stopping it. It comes
  back by itself the next time the agent works or finishes a turn. **Remove** deletes the task from Taskboard (its note goes
  to `~/.taskboard/trash`. The conversation stays in Claude Code / Codex). The same buttons are in the task panel.
- **New task:** pick the machine, then a folder from the recent/pinned list or with **Browse…** (click folders to open
  them, "Choose" or "Use this folder" to select).
- **Your files into an inbox:** drop files from Finder on a task's panel or its board card, or use "Add files…" on the
  Inbox tab. The agent is told like for documents from other tasks.
- **Groups** are notes in `~/AgentVault/groups/`. A task can be in any number of groups.
  When a group manager runs `tb new` without `--group`, Taskboard adds the new task to its managed group.
  A manager of more than one group must use `--group` to choose one. Taskboard keeps an explicit choice.
- **Resume:** Claude sessions get a fixed `--session-id`; Codex thread ids come from its notify events. If tmux or the
  machine restarts, tasks show *Suspended*. Opening one runs `claude --resume` / `codex resume`.
- **Import:** "Import sessions" lists Claude Code and Codex sessions from the last 14 days (read-only).
- **Sessions running in another terminal** (imported while open) carry a `⧉ ttys…` label. That is where they run, not a
  status. Their status is read every 2 s from the end of their transcript:
  - turn ended → Done · unread (the last message becomes "Now")
  - the file changed in the last 15 s, or the turn is in progress → Working
  - Claude Code: a tool call without a result for 30 s and no command shell running under the agent → Needs you
    ("Probably waiting for your approval in ttys…"). Codex sessions never get this, because a running Codex command
    cannot be told apart from an approval prompt.
- **Move it here** stops the process in the other terminal (SIGTERM, then SIGKILL after 5 s) and resumes the conversation
  here. Between turns nothing is lost. During a turn you choose between "Move it when this turn ends" (waits for the
  transcript to show the turn ended. Nothing is interrupted) and "Stop it now and move it" (cuts the turn off, including
  a running command. The saved conversation is kept).
- **One server and one controller per machine.** `~/.taskboard/server.pid` records the running server. A second one exits
  with a message. The machine has a name (default: the Mac's local host name. Change it on the Accounts page). Starting
  Taskboard starts the controller, and if the controller exits Taskboard starts it again within a minute (setting on the
  Accounts page). The controller knows its machine ("Are you the controller for this machine?"), and `tb info` prints it.
- **Remote Control (Claude Code controller):** the controller runs with `--remote-control`, named
  "Taskboard controller · <machine>", so you can continue it from claude.ai/code or the Claude mobile app. The link is on
  the Accounts page, in the controller's panel, and as 📱 next to Controller in the sidebar. A changed name or setting is
  applied by restarting the controller between turns. It resumes the same conversation and keeps the same link.
  For this to work while you are away, the server must be running: install `scripts/install-launchd.sh`.
- **Settings page:** whether the controller, and separately other agents, may start, type into, set aside and archive
  tasks through `tb` without an approval card (defaults: controller yes, other agents no). Taskboard checks these
  settings for each action. Releasing, rolling back and stopping the server stay blocked for every agent.
- **Controller (⌘K):** an agent session in `~/AgentVault/controller` that manages agents with the `tb` command.
  Choose its account on the Accounts page. The account sets the controller's agent.
  The Settings page controls whether its actions need an approval card.
  A Claude Code controller starts with `--dangerously-skip-permissions` by default. Turn this off in the Controller section
  of Settings. Taskboard still checks `tb` actions and permit requests. The change takes effect after the controller's
  current turn ends and Taskboard restarts its session.
- **Task routing:** the Settings page stores machine rules in `~/.taskboard/machine.json`.
  The Accounts page stores each account's rules in `~/.taskboard/accounts.json`.
  The controller reads `tb accounts` before it starts work. A Claude Code controller also gets current usage in its prompt hook.
  The user can choose an agent, account, or model in a request. `tb new` accepts `--account` and `--model`.
- **`tb`** (linked into `~/.local/bin/tb`): `tb list`, `tb show`, `tb log`, `tb tail`, `tb result`, `tb wait`, `tb send`,
  `tb accounts`, `tb new` (also `--batch plan.json`), `tb group`, `tb doc send`, `tb dep`, `tb deps`, `tb review`, `tb park|archive`. Run `tb` for help.
- **Task links:** a task can depend on, replace, follow up or relate to another task. The links are in the task note frontmatter
  (`links`). The server computes the other direction and a state: blocked, ready, superseded or done (archived). A replaces link
  parks the old task. When a task is no longer blocked, Taskboard tells it and the controller in their inboxes. Add links with
  `tb dep add <task> --on|--replaces|--follows|--related <task>`, `tb new --after <task>`, or the Links section of the task panel.
  `tb deps <task> --all` and the linked work overview show every task linked to a task, whatever groups they are in.
  Suggestions come from task parents, sent documents and equal titles. They change nothing until you confirm one.
- **New task files:** Taskboard creates a separate worktree and task branch when the chosen folder is a Git repository root.
  Use `tb new --no-worktree` or "Use the folder as is" in the new task form when you need the original folder.
  A new worktree uses the source folder's `node_modules` when present. Otherwise Taskboard installs dependencies from a supported lockfile.
  Run `pnpm test` to see every test name and the name of any failed test.
  Tests that start servers or tmux sessions use separate ports, folders, and socket names.
  Wait for the expected screen, file, or server state with `tests/helpers/wait-for.ts`.
  Include the last screen and expected state in a wait failure. Keep fixed sleeps only when elapsed time is the behavior under test.
- **Attached scopes:** A task can request another worktree or read folder with `tb scope request`.
  Each request needs user approval. Settings > Approvals > Scope requests controls the maximum attached scopes per task.
  The count maximum is off by default. When on, it accepts a positive whole number.
  Read folders and attached worktrees count together. The initial task folder does not count.
  Lowering the maximum keeps existing scopes. New attachments fail at or above the maximum.
  `tb scope list` shows the count and effective maximum. Taskboard checks the maximum again when approval adds the scope.
  At most three scope requests can wait for approval at once. Account task limits still apply to new task starts.
- **Task processes:** `tb run <name> [--port n] [--stop "<command>"] [--cwd dir] -- <command>` starts a dev server,
  database or other process for the agent's task. A group owns no processes. Each process runs in its own window
  of the tmux session `proc-<num>`, so it keeps running when the Taskboard server
  restarts. The list is `procs.json` in the task folder, the output is `procs/<name>.log`. The task panel's Processes
  tab starts, stops and restarts them and shows the log. `tb ps` and `tb proc logs|restart|stop <name>` do the same.
  End & archive and the idle suspend end every process: Taskboard runs the stop command, sends SIGTERM to the process
  group, sends SIGKILL after 5 s, and then ends processes that left the group (found by `TB_PROC_OWNER` in their
  environment). Resume starts the processes that the suspend ended. Deleting a group, or taking a task out of it,
  stops nothing.
- **Approved task run:** `tb permit run-request <name> --reason "text" --risk "text" --command "python3 /absolute/script.py" --cwd /absolute/folder --network`
  asks the user to start one script. The card shows the command, script SHA-256 hash, folder, network flag, task owner,
  and risk. Taskboard checks these facts again after approval. It starts the script as a task process without the short
  permit timeout. `tb permit result <id> --wait` reports its exit code and log tail. `tb proc logs <process-name>` shows
  more output. `tb proc stop <process-name>` sends SIGINT and allows 120 seconds for cleanup before stronger signals.
  An approved run stays active during idle suspension. It cannot restart or be removed from the process list.
  If its process is missing after a server restart, its result becomes unknown and requires inspection.
- **What runs for a task:** the task panel's tab row and each Canvas window header show a count, for example
  "1 browser · 2 processes", and nothing when nothing runs. A click shows the items with their memory and opens the
  Browser tab, the Processes tab or the pop-out. Canvas → Browsers & processes lists the items of every task in the
  view, each with the task that owns it, a Stop button for that one item, and a total count and memory. A click on a row
  opens the owning task. `tb ps --group <name>` prints the same list. Memory is the resident memory (RSS) of the item's
  process group from one `ps` call. RSS counts shared pages in each process, so a Chrome shows about twice the number
  that `footprint` gives. The server reads memory only while a view that shows it is open (every 4 s).
- **Task browsers:** each task gets its own headless Google Chrome with the profile
  `~/.taskboard/browsers/<task>/profile`. The first start copies the template profile, so sign in once in the template
  browser (Settings → Task browsers). Agents use it through the MCP server `task-browser` (`chrome-devtools-mcp`,
  connected through `ws://127.0.0.1:4317/ws/cdp/<task>?key=…`), which starts the browser when it is first used.
  The task panel's Browser tab shows the active tab as a screencast with mouse and key input, and Pop out shows it in its own
  window (an app window in the Mac app). In a Canvas window, 🌐 shows the browser of that task in the window, with the terminal in a strip
  at the bottom (◨ moves the terminal to the right side, ⬓ moves it back). A click on 🌐 starts a stopped browser, and a
  second click shows the terminal only again. Each task keeps its own choice in this app or browser. Canvas → Browsers & processes shows a small still frame of each running task browser. `tb browser open <url>` and `$BROWSER`
  open a page in it. Archive and the idle suspend close the browser. Resume opens it again with the same pages.
  Settings → Task browsers → Sharp view on Retina screens starts task browsers with `--force-device-scale-factor=2`,
  so the view gets two pixels for each CSS pixel. It sends about 2.4 times more data, and agent screenshots are twice
  as large. A running browser changes at its next start. (A DevTools pixel ratio override does not change the size of a
  screencast frame; only this start flag does.)
  Settings → Task browsers chooses, for Claude Code and Codex, the task browser together with the shared Chrome
  extension, the task browser only (`--no-chrome` / `--disable browser_use_external`), or off.
- **Usage limits:** the Accounts page shows each account's windows (5-hour, weekly) with % used and reset time.
  Claude Code: reported by the status line Taskboard gives its sessions (sessions started before this was added show it
  after they are resumed). Codex: read from the newest session file of that account every minute. Automatic account
  choice skips accounts at 100% until their reset. It prefers fewer assigned tasks, then lower usage.
- **Accounts:** each account is a settings folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so accounts run side by side.
  Automatic choice = the least busy signed-in account that is not at its limit. A Claude Code task stopped by a limit
  can move to another account (its transcript is copied and resumed there).
- **Machines:** run Taskboard on another machine, publish it on your Tailscale network with `tailscale serve --bg 4317`,
  and add it (address + its `~/.taskboard/token`) with ＋ next to Machines. Its tasks appear here with a machine label;
  actions and terminals are forwarded to it.
- **Security:** the server listens on 127.0.0.1 only. Browser requests must come from Taskboard's own page. Anything
  else that changes state or opens a terminal must send the token in `~/.taskboard/token`. Agent-written HTML is
  served with a sandbox policy so it cannot call the API. Limit resets and approvals can only be done from the dashboard.
  These are guards against mistakes, not against an agent deliberately working around them (agents run as you).

## Known limits

- Codex sessions started with `-c` overrides run in Codex's "embedded mode" (without its shared background server).
- The Codex approval bell is wired (tmux `alert-bell` hook) but could not be exercised: your Codex setup approves commands
  automatically, so no approval prompt appeared in testing.
- Moving a session to another account works for Claude Code only.
- Documents cannot yet be sent between tasks on different machines (only within one machine).
- The `task-browser` MCP server needs Node 20.19 or 22.12 or newer. Taskboard uses the first such Node it finds (for
  example `/opt/homebrew/opt/node@22/bin/node`). Without one, tasks get no task browser tools.
- Antigravity keeps its own browser. Task browsers are not available for tasks on other machines.
- A task browser has no sign-ins of your normal Chrome profile, only those of the template profile. Some sites refuse
  sign-in in a browser that a program controls.
- macOS does not show the environment of some system programs (for example `/bin/sleep`) to `ps`. A child of such a
  program that leaves its process group is not found by its `TB_PROC_OWNER` mark.
- The server does not start at login unless you run `scripts/install-launchd.sh` once (it stops a manually started server itself).
- System Settings → Login Items shows the server as **Taskboard Server** without the app icon: macOS uses the key
  `AssociatedBundleIdentifiers` only when the program and the app are signed with the same Developer Team ID.
  After a reboot, tasks show Suspended and resume when you open them.
