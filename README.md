# Taskboard

A local board for many Claude Code and Codex agents. Each agent runs unmodified in its own tmux session;
Taskboard shows what each one is doing, which ones need you, and lets you open any of them as a live terminal.

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
- **Is it installed?** `ls ~/Applications/Taskboard.app` for the app; `launchctl print gui/$(id -u)/com.taskboard.server | grep state`
  for the server; `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4317/` should print 200.
- `pnpm app` downloads Electron from its GitHub releases and checks it against the published SHA-256 sums (Electron's
  own installer needs Node 22.12+, so the build does this itself on older Node).

## Run it

The real Taskboard runs from a **release**: a frozen copy of the code in `~/.taskboard/releases/<id>`, reached through
the link `~/.taskboard/app`. The checkout `~/taskboard` (where you and agents change the code) never runs as the real
server; it refuses to. launchd starts the release at login and restarts it within seconds if it stops.

```sh
cd ~/taskboard
pnpm install
pnpm release                     # copy → install → typecheck → build → start check → switch → restart
sh scripts/install-launchd.sh    # once: run the release as a login service that restarts by itself
```

- **Update:** `pnpm release` again. If the new release does not answer within 30 s, it switches back by itself.
  `pnpm release --ref <commit>` releases a commit instead of the current files; `--no-switch` only builds and checks.
- **Go back:** `pnpm rollback` (the release before) or `pnpm rollback <id>`; `pnpm rollback --list` shows them.
- **Try code without touching the real one:** `pnpm sandbox` starts the current folder's code on its own port, folders
  (in the system temp folder) and tmux socket, without a controller, and prints its address; its pages show an orange
  "Sandbox" bar. `pnpm sandbox stop [--clean]`, `pnpm sandbox list`. `pnpm dev` is a sandbox that restarts on code
  changes, with the Vite interface.
- **Stop / restart the real one:** `launchctl kickstart -k gui/$(id -u)/com.taskboard.server` restarts it. Without the
  login service, `pnpm stop` stops exactly the process in `~/.taskboard/server.pid`. Never use `pkill -f` patterns.
  Agents keep running in tmux in every case and reconnect when the server is back.
- **Remove the login service:** `launchctl bootout gui/$(id -u)/com.taskboard.server && rm ~/Library/LaunchAgents/com.taskboard.server.plist`
- **Log:** `~/.taskboard/server.log` (it says when and why the server stopped).
- **Open an agent from a normal terminal:** `tmux -L taskboard attach -t task-<number>` (the task panel has a copy button).
- **Node:** Node 20.19 or newer is recommended; on 20.18 pnpm skips Vite's native bundler unless installing with
  `--force` (the release script does that).

## Mac app

`desktop/` is an Electron app (installed as `~/Applications/Taskboard.app`) that shows the dashboard in its own
window. It contains no server: the server keeps running under launchd, and quitting the app stops nothing.

- Dock badge and menu-bar item with the number of tasks waiting on you; the menu lists them (click one to open it),
  plus Triage and Controller.
- Control-Option-Command-T shows or hides the window from any app (change `shortcut` in
  `~/Library/Application Support/taskboard-desktop/settings.json`).
- Closing the main window only hides it; ⌘Q quits the app.
- Every open window comes back where it was — position, size, and where you were in it (page, canvas view, open task
  panel) — after quitting, a crash, a Taskboard update or a restart of the Mac. The app opens at login by default
  (turn it off with "Open at login" in the menu-bar menu). The list is kept in
  `~/Library/Application Support/taskboard-desktop/settings.json`.
- No title bar: the window buttons appear when the pointer is near the top edge. Drag the window by its top bar or
  the top of the sidebar.
- File → New Task (⌘T) opens the New task dialog, also while a terminal has the keyboard (in a browser, use N).
- New windows: File → New Window (⌘N), New Window for Group (one canvas tab on its own), New Canvas Window (⇧⌘N);
  the same in the Dock icon's right-click menu and the menu-bar item. Window lists all open windows.
- Taskboard's own shortcuts (⌘K, ⌘S, N, C, T, ?) reach the page; pop-out group windows open as app windows; links to
  other sites open in your browser. While the server does not answer, a waiting page reconnects by itself.
- Rebuild and reinstall: `pnpm app` (or `cd desktop && pnpm build && pnpm install-app`). (Electron's own download script needs
  Node 22; on Node 20 the Electron binary was downloaded by hand and checked against its published SHA-256.)

## Developing Taskboard inside Taskboard

Agents that work on Taskboard itself run inside the real one, so the setup keeps the two apart:

- The real server runs a release copy, so editing, rebuilding or breaking `~/taskboard` changes nothing that runs.
- Only you release or roll back (the agents' guard blocks `pnpm release` / `pnpm rollback`).
- Every test copy is a sandbox with its own port, folders and tmux socket; a sandbox refuses to start on the real
  port, `~/.taskboard`, `~/AgentVault` or the `taskboard` tmux socket.
- One server per `~/.taskboard` (an exclusive lock file); a second one exits with a message.
- A PreToolUse hook (`server/hooks/guard.mjs`) blocks Claude Code agents from stopping the real server or its tmux
  sessions, deleting `~/.taskboard`, or releasing (Codex has no such hook; the other rules still apply to it).
- If the server stops anyway, launchd starts it again, and the agents never depended on it (they run in tmux).
- Instructions for agents: `CLAUDE.md` / `AGENTS.md` in the repository.

## Pages and keys

| Page | What it is |
|---|---|
| List | Every task grouped by status, with Goal / Now / Waiting. Tick tasks to group them or open them together. |
| Board | Columns by status, or by group (drag a card onto a group to add it; hold ⌥ to move it). |
| Graph | Tasks in lanes (group, folder or status); arrows show documents sent from one task to another. |
| Canvas | Live terminals. Tabs across the top are your groups. Columns / Grid / Rows. |
| Review | Documents agents asked you to review (`tb review <file>`): comment, send feedback, compare versions, accept. |
| Accounts | Settings folders per account, sign-in, limit marks, and limit resets (only you can use them). |

Keys (press `?` in the app for the full list, with key names written out): `⌘K` (Command-K) controller, also from inside
a terminal · `N` new task · `C` controller · `T` triage (everything waiting on you, longest first) · `⌘S` hide the sidebar.
Single letters work when the cursor is not in a terminal or text field. On the canvas: `⌃⌥←→` focus, `⌃⌥↩` maximize, `⌃⌥L` layout, `⌃⌥F` focus mode (Esc or the button
bottom-right exits), `⌃⌥G` next group tab, `⌃⌥⇧G` new group, `⌃⌥N` next waiting, `⌃⌥.` / `⌃⌥,` text size, `⌃⌥W` remove window, `⌃⌥PageUp` / `⌃⌥PageDown` (or `⌃⌥[` / `⌃⌥]`) previous / next page.
A sideways swipe (or Shift + wheel) over a terminal scrolls the canvas, or turns one page when **Per page** is on.
⌘-click window headers or cards to select several. Drag a window header onto a group tab to add it.

## How it works

- **Agents run in tmux** on a separate tmux server (`tmux -L taskboard`). Closing a terminal in Taskboard only detaches.
- **Status comes from the agents' own events:**
  - Claude Code hooks, passed per session with `claude --settings ~/.taskboard/claude-settings.json`: prompt → working,
    permission request → needs you (with the exact command), finished turn → done · unread (its last message is "Now"),
    API error such as a rate limit → stopped (and the account is marked as at its limit).
  - Codex: a `notify` program passed with `codex -c notify=[…]` reports finished turns (your own notify program is
    still called); a change to Codex's transcript file after a finished turn means it is working again.
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
  turn; the Stop hook asks once if the agent forgot), `terminal.log` (all output), `outbox/` and `inbox/`.
- **Inbox / outbox:** agents save documents (Markdown or HTML) in their `outbox/`. Sending copies a file into another
  task's `inbox/`; Claude Code is told on its next prompt, Codex via "Tell the agent now". HTML opens in a floating
  preview (sandboxed) or in the browser.
- **tmux listing:** tmux is always run with a UTF-8 locale and its session list uses a printable separator; a task
  is only marked Suspended after tmux confirms its session is gone, and a Suspended task whose session is running
  goes back to its status by itself.
- **Terminals:** tmux mouse mode is on, so the mouse wheel scrolls: Claude Code scrolls its own view, and Codex (started
  with `--no-alt-screen`) scrolls through tmux's history. Drag to select copies to the clipboard; ⌥-drag selects directly.
  Terminals draw with WebGL, and output is sent in batches every 8 ms.
- **Managing tasks:** select tasks with their checkboxes (list) or ⌘-click (board, canvas), then use the bar at the bottom:
  Set aside, End & archive, Remove. **Set aside** takes a task off Needs you / Unread / triage without stopping it; it comes
  back by itself the next time the agent works or finishes a turn. **Remove** deletes the task from Taskboard (its note goes
  to `~/.taskboard/trash`; the conversation stays in Claude Code / Codex). The same buttons are in the task panel.
- **New task:** pick the machine, then a folder from the recent/pinned list or with **Browse…** (click folders to open
  them, "Choose" or "Use this folder" to select).
- **Your files into an inbox:** drop files from Finder on a task's panel or its board card, or use "Add files…" on the
  Inbox tab. The agent is told like for documents from other tasks.
- **Groups** are notes in `~/AgentVault/groups/`. A task can be in any number of groups.
- **Resume:** Claude sessions get a fixed `--session-id`; Codex thread ids come from its notify events. If tmux or the
  machine restarts, tasks show *Suspended*; opening one runs `claude --resume` / `codex resume`.
- **Import:** "Import sessions" lists Claude Code and Codex sessions from the last 14 days (read-only).
- **Sessions running in another terminal** (imported while open) carry a `⧉ ttys…` label; that is where they run, not a
  status. Their status is read every 2 s from the end of their transcript:
  - turn ended → Done · unread (the last message becomes "Now")
  - the file changed in the last 15 s, or the turn is in progress → Working
  - Claude Code: a tool call without a result for 30 s and no command shell running under the agent → Needs you
    ("Probably waiting for your approval in ttys…"). Codex sessions never get this, because a running Codex command
    cannot be told apart from an approval prompt.
- **Move it here** stops the process in the other terminal (SIGTERM, then SIGKILL after 5 s) and resumes the conversation
  here. Between turns nothing is lost. During a turn you choose between "Move it when this turn ends" (waits for the
  transcript to show the turn ended; nothing is interrupted) and "Stop it now and move it" (cuts the turn off, including
  a running command; the saved conversation is kept).
- **One server and one controller per machine.** `~/.taskboard/server.pid` records the running server; a second one exits
  with a message. The machine has a name (default: the Mac's local host name; change it on the Accounts page). Starting
  Taskboard starts the controller, and if the controller exits Taskboard starts it again within a minute (setting on the
  Accounts page). The controller knows its machine ("Are you the controller for this machine?"), and `tb info` prints it.
- **Remote Control (Claude Code controller):** the controller runs with `--remote-control`, named
  "Taskboard controller · <machine>", so you can continue it from claude.ai/code or the Claude mobile app. The link is on
  the Accounts page, in the controller's panel, and as 📱 next to Controller in the sidebar. A changed name or setting is
  applied by restarting the controller between turns; it resumes the same conversation and keeps the same link.
  For this to work while you are away, the server must be running: install `scripts/install-launchd.sh`.
- **Settings page:** whether the controller, and separately other agents, may start, type into, set aside and archive
  tasks through `tb` without an approval card (defaults: controller yes, other agents no). The controller's Claude Code
  settings allow every `tb` command and a Codex controller runs with `-a never`, so this page is the only place that
  decides. Releasing, rolling back and stopping the server stay blocked for every agent.
- **Controller (⌘K):** an agent session in `~/AgentVault/controller` (Claude Code or Codex: choose its account on the
  Accounts page; the account decides the agent) that manages agents with the `tb` command.
  Starting agents, typing into them, parking and archiving wait for your **Approve / Deny** card on the dashboard,
  whatever Claude Code's permission mode is.
- **`tb`** (linked into `~/.local/bin/tb`): `tb list`, `tb show`, `tb log`, `tb tail`, `tb result`, `tb wait`, `tb send`,
  `tb new` (also `--batch plan.json`), `tb group`, `tb doc send`, `tb review`, `tb park|archive`. Run `tb` for help.
- **Usage limits:** the Accounts page shows each account's windows (5-hour, weekly) with % used and reset time.
  Claude Code: reported by the status line Taskboard gives its sessions (sessions started before this was added show it
  after they are resumed). Codex: read from the newest session file of that account every minute. Automatic account
  choice skips accounts at 100% until their reset and prefers the least used.
- **Accounts:** each account is a settings folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so accounts run side by side.
  Automatic choice = the least busy signed-in account that is not at its limit. A Claude Code task stopped by a limit
  can move to another account (its transcript is copied and resumed there).
- **Machines:** run Taskboard on another machine, publish it on your Tailscale network with `tailscale serve --bg 4317`,
  and add it (address + its `~/.taskboard/token`) with ＋ next to Machines. Its tasks appear here with a machine label;
  actions and terminals are forwarded to it.
- **Security:** the server listens on 127.0.0.1 only. Browser requests must come from Taskboard's own page; anything
  else that changes state or opens a terminal must send the token in `~/.taskboard/token`. Agent-written HTML is
  served with a sandbox policy so it cannot call the API. Limit resets and approvals can only be done from the dashboard.
  These are guards against mistakes, not against an agent deliberately working around them (agents run as you).

## Known limits

- Codex sessions started with `-c` overrides run in Codex's "embedded mode" (without its shared background server).
- The Codex approval bell is wired (tmux `alert-bell` hook) but could not be exercised: your Codex setup approves commands
  automatically, so no approval prompt appeared in testing.
- Moving a session to another account works for Claude Code only.
- Documents cannot yet be sent between tasks on different machines (only within one machine).
- The server does not start at login unless you run `scripts/install-launchd.sh` once (stop the manually started server first).
  After a reboot, tasks show Suspended and resume when you open them.
