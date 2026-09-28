# Taskboard

A local board for many Claude Code and Codex agents. Each agent runs unmodified in its own tmux session;
Taskboard shows what each one is doing, which ones need you, and lets you open any of them as a live terminal.

## Run it

```sh
cd ~/taskboard
pnpm install
pnpm build          # builds the web interface into web/dist
pnpm start          # serves it on http://127.0.0.1:4317
```

- Stop: `pkill -f "tsx server/index.ts"`. The agents keep running in tmux; start the server again to reconnect.
- Server log: `~/.taskboard/server.log` (when started with `nohup … > ~/.taskboard/server.log`).
- Development with live reload: `pnpm dev` (server on 4317, interface on http://localhost:5173).
- Open any agent from a normal terminal: `tmux -L taskboard attach -t task-<number>` (the task panel has a copy button).

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
bottom-right exits), `⌃⌥G` next group tab, `⌃⌥⇧G` new group, `⌃⌥N` next waiting, `⌃⌥.` / `⌃⌥,` text size, `⌃⌥W` remove window.
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
- **Tasks are Markdown notes** in `~/AgentVault/tasks/<id>.md`. Each task folder has `log.md` (Did / Waiting / Next per
  turn; the Stop hook asks once if the agent forgot), `terminal.log` (all output), `outbox/` and `inbox/`.
- **Inbox / outbox:** agents save documents (Markdown or HTML) in their `outbox/`. Sending copies a file into another
  task's `inbox/`; Claude Code is told on its next prompt, Codex via "Tell the agent now". HTML opens in a floating
  preview (sandboxed) or in the browser.
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
