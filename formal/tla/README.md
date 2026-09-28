# TLA+ models of Taskboard

This folder has five TLA+ specifications of the Taskboard server in `server/` and its scripts in `scripts/`. TLC, the TLA+ model checker, checks each one. Each specification models what the code does, and cites the code as `path:line` in comments. The goal is to decide whether the design is sound as it is, or whether the core should be restructured or ported (for example to Rust). A counterexample is a sequence of steps that TLC found and that breaks a property. The counterexamples matter more than the passes.

Nothing in the real Taskboard was run, stopped or changed. Only files in this folder were written.

## Terms used in this document

- **State**: one value for every variable of a specification.
- **Invariant**: a condition that must be true in every reachable state. TLC reports the shortest sequence of steps that reaches a state where it is false.
- **Liveness property**: a condition about infinite runs, for example "from some point on, a server is always up". TLC reports a run that ends in a loop, or ends by stopping, where the condition never becomes true.
- **Fairness**: an assumption that a step which stays possible is eventually taken. For example: launchd eventually restarts a stopped job, and the 2-second `reconcile()` timer eventually fires. Steps taken by the user, crashes and pid reuse have no fairness: they may never happen.
- **Budget**: a bound on how many times the environment does something, such as server crashes or user prompts. With a budget, a run eventually stops changing, so a liveness property asks whether the system settles.
- **old / new / fixed**: most specifications have these variants.
  - **old**: the design before today's fixes. It is rebuilt from the task description and from code comments, because this checkout has no git history.
  - **new**: the code as it is now.
  - **fixed**: a code change that I propose, modelled so that it can be checked. It is not in the code.

## How to run

```sh
cd formal/tla
python3 run.py ServerInstance_new.cfg        # one TLC run per property; results in runs/results.tsv
python3 trace.py runs/ServerInstance_new__MutualExclusion.out   # the counterexample, one line per step
```

- `run.py` splits a `.cfg` so that each invariant and each liveness property gets its own TLC run. One failing property therefore does not hide the others.
- Each run writes its config and the full TLC output to `runs/<cfg>__<property>.cfg` and `.out`.
- Every run finished in under 2 seconds. The largest state space has 14,418 distinct states.
- The TLC command is `java -XX:+UseParallelGC -cp ~/.local/share/tla/tla2tools.jar tlc2.TLC -workers auto -deadlock -config X.cfg X.tla`. `-deadlock` turns off the deadlock check. Every model eventually stops when its budgets are used up, and that final state is not an error.

## Results table

"VIOLATED" means TLC found a counterexample. Each counterexample is described under its specification below.

| Specification / config | Property | old | new (current code) | fixed (proposal) |
|---|---|---|---|---|
| ServerInstance | MutualExclusion | VIOLATED | VIOLATED | pass |
| ServerInstance | SingleReconciler | VIOLATED | VIOLATED | pass |
| ServerInstance | HolderRecorded | VIOLATED | VIOLATED | pass |
| ServerInstance | FileNamesOnlyHolder | pass | pass | pass |
| ServerInstance | NoForeignSignal | VIOLATED | VIOLATED | VIOLATED (the stop script is unchanged) |
| ServerInstance | EventuallyAlwaysUp | VIOLATED | VIOLATED | pass |
| Release | EventuallyAlwaysUp | — | VIOLATED (two different counterexamples) | pass |
| AgentLifecycle, worker, Claude | NoKillMidTurn | VIOLATED | VIOLATED | pass |
| AgentLifecycle, worker, Claude | NoKillMidTurnByReconcile | pass (never reached) | VIOLATED | pass |
| AgentLifecycle, worker, Claude | NoKillLiveOnListingError | VIOLATED | pass; VIOLATED when tmux calls fail now and then | pass |
| AgentLifecycle, worker, Claude | NoFalseSuspendForever | VIOLATED | pass | pass |
| AgentLifecycle, worker, Claude | StatusConverges | VIOLATED | VIOLATED | pass |
| AgentLifecycle, worker, Codex | NoKillMidTurn | — | VIOLATED | VIOLATED |
| AgentLifecycle, worker, Codex | StatusConverges | — | VIOLATED | pass |
| AgentLifecycle, controller | NoKillLiveOnListingError | VIOLATED | pass | pass |
| AgentLifecycle, controller | ControllerSettles | VIOLATED | pass | pass |
| AgentLifecycle, controller | ControllerAlive | pass (see note) | pass; VIOLATED if `list-panes` output cannot be parsed again | pass |
| AgentLifecycle, controller | NoKillMidTurn | pass | VIOLATED | pass |
| AgentLifecycle, other terminal | NoKillMidTurn | — | VIOLATED | — (no fix without help from the CLI) |
| Approvals | AtMostOncePerApproval | — | VIOLATED | pass |
| Approvals | AtMostOncePerIntent | — | VIOLATED | pass |
| Approvals | DeniedNeverRuns | — | VIOLATED | pass |
| Approvals | ErrorMeansNotRun | — | VIOLATED | pass |
| Approvals | OkMeansRun | — | pass | pass |
| Approvals | AnswerArrives | — | pass | pass |
| Approvals (the controller skips the approval) | NoExecWithoutApproval | — | VIOLATED | not addressed |

The per-run state counts and times are in `runs/results.tsv`.

---

## 1. ServerInstance.tla — several server processes and one TB_DIR

### What it models

- Two server process slots, `s1` and `s2`, both started against the same `<TB_DIR>`. launchd supervises `s1` and restarts it whenever it is not running (`scripts/install-launchd.sh:20-22`, KeepAlive). `s2` is a server started by hand, at most twice.
- The lock file `<TB_DIR>/server.pid` (`server/lock.ts:9`). Its value in the model is one of these:
  - missing;
  - created by process `s` but still empty;
  - holding the pid of `s`;
  - left behind by a process that has died.
- Three versions of `acquire()`:
  - **new** (`server/lock.ts:24-42`), the current code:
    1. `openSync(FILE,'wx')` creates the file only if it does not exist.
    2. A separate `writeSync` writes the pid into it.
    3. If the create fails with EEXIST, `liveHolder()` reads the file (`lock.ts:13-21`).
    4. If there is no live holder, `unlinkSync(FILE)` deletes the file and the loop tries again. It tries 3 times, then gives up (`lock.ts:41`).
  - **old**: read the file; exit if it names a live server; otherwise write the file. The write is not exclusive.
  - **fixed** (proposal): call `listen()` on the port first. The kernel lets only one process bind the port and frees it when that process dies. Only then overwrite `server.pid` and do the startup work.
- What the server does after it takes the lock. It runs `reconcile()` (`server/index.ts:582`) and starts the controller (`index.ts:586`) BEFORE `server.listen()` (`index.ts:596`). A listen error calls `process.exit(1)` (`index.ts:595`). The exit handler (`lock.ts:45`) then deletes `server.pid` if the file names this process.
- Crashes (SIGKILL): no exit handler runs, `server.pid` stays behind, and the kernel frees the port.
- Pid reuse. The pid in a left-behind `server.pid` can later belong to one of two kinds of process:
  - an unrelated process;
  - another process whose command line contains `server/index.ts`, for example a sandbox or a test server. `liveHolder()` accepts that as a live Taskboard server (`lock.ts:18-19`).
- `scripts/stop.mjs:7-9` sends SIGTERM to the pid in `server.pid` without checking what that process is. `restartProduction()` does the same when launchd is not in use (`scripts/lib.mjs:58`).

### What it leaves out

- Time: launchd's 10-second throttle and the script waits.
- A non-Taskboard process holding port 4317.
- The content of the startup work.
- SIGTERM that arrives before the handler is installed. Node's default action ends the process without running exit handlers, so the model treats it as a crash.

### Properties

- **MutualExclusion**: at most one process believes it holds the lock.
- **SingleReconciler**: at most one process runs `reconcile()` or `startController()` against the shared tmux socket at a time.
- **HolderRecorded**: a process that is past startup is the one named in `server.pid`. Other starters and `pnpm stop` rely on this.
- **FileNamesOnlyHolder**: `server.pid` never names a live process that does not hold the lock.
- **NoForeignSignal**: no script sends SIGTERM to a process that is not a Taskboard server.
- **EventuallyAlwaysUp** (liveness; crashes and manual starts are bounded; launchd and the steps of each process are fair): from some point on, some server is always up.

### Results

- **MutualExclusion, new: VIOLATED** (10 steps). An empty `server.pid` is treated as stale, and the check and the delete are separate steps:
  1. `s2` creates `server.pid` with `openSync('wx')`. The file is still empty.
  2. launchd starts `s1`. Its exclusive create fails with EEXIST.
  3. `s1` reads the file. `JSON.parse` of the empty file throws, so `liveHolder()` returns null, which means "stale".
  4. `s1` deletes the file. This is `s2`'s file.
  5. `s1` creates and writes its own `server.pid`.
  6. `s2` runs `writeSync` on its file descriptor. The write goes into the deleted file. `s2` continues as the lock holder.
  7. Now both `s1` and `s2` hold the lock.

  The same result happens without an empty file:
  1. Two starters both read one stale file and both find no live holder.
  2. The first deletes the file and creates its own.
  3. The second then deletes the first one's new file, because `unlinkSync` deletes whatever is at the path, and creates its own.

  The comment at `lock.ts:36-37` says the losing starter "sees it as a live holder" on its next attempt. That is only true when it reads the file before it deletes it.
- **SingleReconciler, new: VIOLATED** (10 steps). This follows from MutualExclusion. Both processes run `reconcile()` and `startController()` on tmux socket `taskboard` before either one calls `listen()`.
- **HolderRecorded, new: VIOLATED** (8 steps). This is the empty-file sequence above. `s1` deletes `s2`'s file, so `s2` runs without a `server.pid`. Two consequences follow:
  - When the second holder fails `listen()`, its exit handler deletes its own `server.pid`. The server that serves the port is then not recorded anywhere.
  - Every later launchd restart of `s1` then gets the lock, runs a full `reconcile()` and `startController()` beside the real server, fails `listen()`, and exits. This repeats every 10 seconds until the real server stops.
- **MutualExclusion / SingleReconciler / HolderRecorded, old: VIOLATED** (7 steps). Both starters read "no file", both write, and both continue.
- **EventuallyAlwaysUp, old and new: VIOLATED**. The steps:
  1. A server is SIGKILLed and leaves `server.pid` behind.
  2. The OS gives the recorded pid to a sandbox or test server. Its command line matches `/server\/index\.ts/`.
  3. From then on, every launchd restart of the real server calls `liveHolder()`, which returns that process. The real server prints "already running" and exits.
  4. The loop goes on for as long as the other process lives.

  The pid reuse must land on a matching command line, so this is rare. But nothing ends it.
- **NoForeignSignal: VIOLATED in all three variants** (7 steps):
  1. The server crashes and leaves `server.pid` behind.
  2. The pid is reused by an unrelated process.
  3. `pnpm stop` (`scripts/stop.mjs:9`) sends SIGTERM to that process.

  `restartProduction()` without launchd (`scripts/lib.mjs:58`) does the same. The fixed lock order does not change these scripts. The fix is in the scripts: before signalling, check the command line of the process (as `liveHolder()` does), or ask the server for its pid over HTTP.
- **fixed (listen first): every property except NoForeignSignal passes** (434 states). Only the process that bound the port continues, and the kernel releases the port when that process dies. So the lock needs no staleness check and no pid-reuse logic.

## 2. Release.tla — `pnpm release` switching releases under launchd

### What it models

- `~/.taskboard/app`, a symlink that `switchTo()` replaces atomically (`scripts/lib.mjs:72-77`).
- launchd starts whatever `app` points to at the moment it (re)starts the job (`install-launchd.sh:17-18`).
- The release script (`scripts/release.mjs:69-80`), in order:
  1. `switchTo(B)`.
  2. `restartProduction()`, which runs `launchctl kickstart -k`.
  3. Wait up to 30 seconds for `/api/info` from a new pid.
  4. If the answer is not from B, run `switchTo(A)` and restart again.
- The script process can stop at any step: a closed terminal, Ctrl-C, or the laptop sleeping.
- The new release B has one of three qualities:
  - "good";
  - "badStart": never answers;
  - "badLate": passes the sandbox start check (`release.mjs:47-58`) and answers within 30 seconds, then crashes, for example on real data or real tmux sessions.
- **fixed** (proposal): the launchd job runs a small wrapper. The wrapper counts starts that crash before a health mark. After 2 such starts, it points `app` back at the last release that reached the mark.

### Property

- **EventuallyAlwaysUp**: from some point on, the real Taskboard is always up.

### Results

- **current: VIOLATED**, two separate counterexamples:
  - B is "badStart", and the script stops after `switchTo(B)` and the kickstart, before its 30-second rollback. `app` stays on B, and launchd restarts the broken release every 10 seconds forever.
  - With the script never stopping (config `Release_currentNoDie.cfg`): B is "badLate". B answers within 30 seconds, the script reports success, then B crashes. launchd restarts B, B crashes again, and this repeats. Nothing ever goes back to A. The rollback only covers the first 30 seconds, and only while the script process is alive.
- **fixed: pass** (115 states).

## 3. AgentLifecycle.tla — agent reality, hook events, the server's view, and actions based on the view

### What it models

The model covers one task at a time. `Role` chooses which kind of task:

- **worker**: a task in Taskboard's tmux. `reconcile()` handles it at `server/index.ts:554-580`.
- **controller**: kept alive by `keepController()` (`index.ts:519-545`) and `startController()` (`server/agents.ts:90-113`).
- **elsewhere**: a session open in another terminal. The server follows it by reading its transcript (`watchElsewhere`, `index.ts:466-503`). The server moves it into tmux when its turn ends (`moveWhenDone`, `index.ts:497-502`).

The variables:

- The real agent: no session, idle, in a turn, waiting for approval, or exited (the tmux pane is dead). The user or the controller may type a new prompt at any moment the agent is idle.
- Hook events. Each event travels from the CLI to the server as a separate HTTP request. If the server is down, the request fails and the hook script drops the event (`server/hooks/claude-hook.mjs:25`, `server/hooks/codex-notify.mjs:28`).
  - **Claude Code** (`Kind = "claude"`): Claude Code waits for each hook to finish before it continues. The script gives up after 4 seconds (`claude-hook.mjs:21`). The events are UserPromptSubmit, PermissionRequest, PostToolUse and Stop.
  - **Codex** (`Kind = "codex"`): Codex has no prompt event. At the end of a turn, Codex runs its notify program without waiting for it. An approval request rings the bell (`server/events.ts:114-118`). A new turn is noticed only when `reconcile()` finds that the transcript file changed after the last event (`events.ts:122-129`).
- The server's view (`status`): working, needs-you, idle, or suspended. The statuses idle and unread are merged, because every check modelled here treats them the same (`index.ts:207, 217, 528, 572`).
- The server process can crash and start again. Tasks are kept on disk; in-memory state is lost.
- The tmux listing (`Listing` constant):
  - **oldBug**: `list-panes` output never parses. This was the launchd locale bug: `listSessions()` returned `[]`. `has-session` works.
  - **transient**: any single `list-panes` or `has-session` call may fail. `tmuxQuiet()` turns every error into "no sessions" or "no such session" (`server/tmux.ts:16-18, 25, 34`). Failures are bounded, so tmux eventually answers again.
  - **ok**: tmux calls never fail.
- Actions that the server takes based on its view:
  - `restartWhenDone`: the immediate restart when the view says idle (`index.ts:217`), and the restart by `reconcile()` (`index.ts:572`).
  - The controller restart after a setting change, "between turns" (`index.ts:528-532`).
  - `moveWhenDone`, which sends SIGTERM to the other terminal's process (`agents.ts:275-287`).
  - Opening a suspended task in the dashboard resumes it (`web/src/components/TaskPanel.tsx:27`). `resumeTask` kills any existing session first (`agents.ts:238`).
- **old** (rebuilt from the task description and the comments at `agents.ts:97-98` and `index.ts:562, 567`):
  - no `has-session` confirmation before marking a task suspended;
  - no recovery of a suspended task whose session is running;
  - `startController()` kills an existing session that is missing from the listing.
- **fixed** (proposals):
  - (a) Do "restart after the turn" and "restart the controller with new settings" inside the Stop hook request, while Claude Code is still waiting for that hook. A restart request that arrives while the task is not suspended only sets the flag.
  - (b) In `reconcile()`, also read the transcript of tmux-owned sessions, as `server/external.ts` already does for other terminals, and correct `status` from it.
  - (c) `resumeTask` and the immediate restart kill only a session whose pane tmux reports dead or missing. For a running session, they only set status idle.

### What it leaves out

- Time, except the controller's 60-second restart limit.
- The Stop hook "block" that asks for a log entry (`events.ts:63-67`).
- A finished turn that ends with a question and becomes "needs-you".
- The statuses review, parked, archived and stopped.
- SessionStart and `screenCheck`.
- Several tasks at once.
- Two `reconcile()` passes running at the same time. `setInterval` does not wait for the previous async pass (`index.ts:591`), so this can happen in the real code; the model does not include it.

### Properties

- **NoKillMidTurn**: an "after the turn" or "between turns" action never kills a session while its agent is in a turn or waiting for approval.
- **NoKillMidTurnByReconcile**: the same, but only for the kill done by `reconcile()` at `index.ts:572`.
- **NoKillLiveOnListingError**: a live agent is never killed because of a listing error, or because its status was wrongly "suspended".
- **NoFalseSuspendForever** (leads-to): if a live session is marked suspended, it is later marked otherwise, or it stops being live.
- **ControllerAlive**: from some point on, the controller is always running. Exits, crashes and setting changes are bounded.
- **ControllerSettles**: from some point on, the controller is not relaunched again. Nothing changes infinitely often.
- **StatusConverges**: once the environment stops acting (all budgets used), `status` ends up equal to the agent's real state and stays equal.

### Results: NoKillMidTurn — VIOLATED in the current code, as expected

- **Worker, Claude, new — the immediate path** (3 steps; `index.ts:217`):
  1. The agent is idle and the view says idle. The user types a prompt in the terminal. Claude Code starts the turn and runs the UserPromptSubmit hook. The hook request is in flight.
  2. On the dashboard, the user clicks "restart after this turn". The view still says idle, so `index.ts:217` calls `restartTask()` at once.
  3. `restartTask()` kills the session. The new turn is killed and its prompt is lost.
- **Worker, Claude, new — through `reconcile()`** (8 steps; `index.ts:572`). This is the trace the task asked for:
  1. The agent is in a turn and the view says working.
  2. The turn ends. The Stop hook is in flight.
  3. The user asks for "restart after this turn". The view is still working, so `restartWhenDone` is set (`index.ts:217`).
  4. The Stop event arrives. The view becomes idle.
  5. The user types a new prompt. The agent is in a turn, and its UserPromptSubmit event is in flight.
  6. `reconcile()` sees `restartWhenDone` and view idle, and calls `restartTask()`. The running turn is killed.

  The window is the time between pressing Enter and the server handling UserPromptSubmit. That includes the hook's Node start-up, typically 100–300 ms, and can be up to 4 s under load.
- **Worker, Codex, new** (9 steps). Codex has no prompt event, so the window is much wider:
  1. The notify event for the previous turn arrives after the user has already started the next turn. The view becomes idle while Codex is working.
  2. `reconcile()` checks `restartWhenDone` (`index.ts:572`) before it checks the transcript (`index.ts:575-578`). So even when the transcript already shows the new turn, the restart runs first in the same pass.
  3. In addition, `codexActivity()` ignores changes within 1.5 s of the last event and within 20 s of a launch (`events.ts:123-125`).
- **Controller, new** (4 steps; `index.ts:528`):
  1. The user renames the machine or toggles Remote Control. `launchedAs` no longer matches.
  2. The user sends the controller a prompt. Its UserPromptSubmit event is in flight.
  3. `keepController()` sees view idle and kills the controller mid-turn.
- **Other terminal, new** (4 steps; `index.ts:207-209`, `agents.ts:275-287`):
  1. The session in the other terminal is in a turn, waiting for an approval.
  2. The transcript tail still says "finished" (the file lags behind the agent). `watchElsewhere` has therefore set the view to idle.
  3. "Move it here after this turn" sees idle and calls `takeOver()` at once, which sends SIGTERM to the running turn.

  The same happens through `moveWhenDone` at `index.ts:497` when a new turn starts between the transcript read and the kill.
- **Fixed, Claude: pass** (5,655 states). The Stop hook is the one moment when the agent cannot start a new turn: Claude Code is still waiting for the hook's answer. A restart done inside that request cannot hit a turn.
- **Fixed, Codex: still VIOLATED.** Codex runs its notify program without waiting for it, so the "turn ended" message can arrive after the next turn started. No server-side change closes this. It needs an "exit if idle" operation, or a blocking end-of-turn hook, from the Codex CLI. The same limit applies to moving a session from another terminal: SIGTERM to another process can always race with the user's typing in that terminal.

### Results: listing errors

- **Old, worker**:
  - NoKillLiveOnListingError is VIOLATED (5 steps). The broken listing marks a live session suspended. When the user opens the task, `TaskPanel.tsx:27` calls resume, and `resumeTask()` kills the live session (`agents.ts:238`).
  - NoFalseSuspendForever is VIOLATED. With no recovery branch, the task stays "suspended" forever while its agent runs.
- **Old, controller**:
  - NoKillLiveOnListingError is VIOLATED (2 steps). The first `reconcile()` finds the controller missing from the listing and kills it.
  - ControllerSettles is VIOLATED. The trace loops: 60 seconds pass, `reconcile()` runs, the controller is killed and started again, and this repeats. It also kills the controller while it waits for an approval. This is the incident that was reported.
  - ControllerAlive passes only because the model relaunches the controller in the same step as the kill. ControllerSettles is the property that captures the incident.
- **New, listing ok**: NoKillLiveOnListingError, NoFalseSuspendForever and ControllerSettles all pass. Today's fix works for the failure that happened.
- **New, with transient tmux failures: NoKillLiveOnListingError VIOLATED** (3 steps):
  1. In one `reconcile()` pass, both `list-panes` and `has-session` fail, for example because the tmux server was slow or a fork failed. `tmuxQuiet()` turns both errors into "no session", and the task is marked suspended (`index.ts:569`).
  2. The user opens the task before the next pass. Resume kills the live session.

  NoFalseSuspendForever still passes: the next good pass restores the status. But the restored status is "idle" even if the agent is working (`index.ts:564`), so a pending `restartWhenDone` can then kill the turn. Fix (c) passes.
- **New, controller, with `list-panes` output that cannot be parsed again: ControllerAlive VIOLATED.**
  1. The controller exits, and its pane is dead.
  2. `startController()` finds the session with `has-session`, then looks it up in `listSessions()` to check `pane_dead`. The lookup fails, so `if (!s || !s.dead) return t` (`agents.ts:99`) returns without doing anything.
  3. The dead controller is never replaced, and nothing is logged.

  Today's fix swapped the failure "kill a live controller" for the failure "never restart a dead one" when the listing breaks. Distinguishing "tmux call failed" from "no session" in `tmux.ts` would fix both. Today, `tmuxQuiet()` and `listSessions()` return the same value for both.

### Results: StatusConverges — VIOLATED in the current code, passes with fix (b)

- **Claude** (11 steps):
  1. The agent is in a turn, and the server crashes.
  2. The agent asks for a tool approval. The PermissionRequest hook fails, because the server is down, and the event is dropped.
  3. The server comes back.
  4. The dashboard shows "working" forever, while the agent waits for the user.

  The same happens with a lost Stop event: the dashboard shows "working" while the agent is idle. Nothing in the current code reads the real state again for tmux-owned tasks.
- **Codex** (17 steps): the notify event is lost while the server is down. The transcript change from that turn is seen after the restart, so the view says "working" forever while Codex is idle.
- **Fixed (b): pass for both.** `reconcile()` re-derives the status from the transcript, as `external.ts` already does for other terminals.

## 4. Approvals.tla — controller actions that wait for the user

### What it models

- `guarded()` (`server/index.ts:91-96`):
  - A request with the header `x-tb-actor: controller` is stored by `approvals.request()` in an in-memory `Map` (`server/approvals.ts:9-18`) and gets a 202 answer.
  - A request with any other value runs the action at once.
- `tb` (`bin/tb:19-27`) polls `GET /api/approvals/<id>` every 2 seconds, with no time limit. It stops with an error in these cases:
  - a 404, which has an empty body, so `.json()` throws;
  - a refused connection;
  - the controller's Bash tool call reaching its own timeout.
- `decide()` (`approvals.ts:19-24`):
  - If the state is not "pending", it returns without doing anything.
  - Deny sets "denied".
  - Approve waits for the runner to finish, and only then sets "approved" or "failed". While the runner runs, the state is still "pending". During that time the dashboard still shows the card with active Approve and Deny buttons (`web/src/App.tsx:171-175`).
- The server can stop at any step. The `Map` is lost.
- The controller agent may try the same action again after an error.
- The runner is split into three steps:
  1. started;
  2. side effect done (for example a task started, or keys typed into a session);
  3. state written.

### Properties

- **NoExecWithoutApproval**: no action runs without an approval.
- **AtMostOncePerApproval**: one approval runs its action at most once.
- **AtMostOncePerIntent**: one action that the controller intended runs at most once, even when the controller retries it.
- **DeniedNeverRuns**: an approval that was denied never runs.
- **ErrorMeansNotRun**: when `tb` reports an error, a denial or a failure, the action has not run and will not run.
- **OkMeansRun**: when `tb` reports success, the action ran.
- **AnswerArrives**: once the user has decided, `tb` stops waiting.

### Results (current code)

- **AtMostOncePerApproval: VIOLATED** (6 steps):
  1. The user clicks Approve.
  2. `startTask` takes several seconds (`git worktree add`, tmux launch). During that time the card still shows, with its buttons.
  3. The user clicks Approve again, or approves from a second window, such as a phone.
  4. The second `decide()` also sees "pending" and runs the runner again. Two tasks start, or the text is typed twice.
- **DeniedNeverRuns: VIOLATED** (5 steps):
  1. Approve, then Deny while the runner is still running.
  2. The state becomes "denied". A `tb` poll in that window tells the controller "not done: Denied by the user." (exit code 3).
  3. The runner finishes, and `x.state = 'approved'` overwrites "denied".
  4. The action ran after the controller had been told it was denied.
- **ErrorMeansNotRun: VIOLATED** (5 steps):
  1. The controller's `tb` call stops. In the model this is the Bash tool timeout. A server restart, which turns the next poll into a 404 or a refused connection, has the same effect.
  2. The approval is still on the dashboard. The user approves it later.
  3. The action runs after the controller was told that it failed.

  A second counterexample goes the other way:
  1. The server crashes after the side effect and before the state is written.
  2. `tb` gets a 404 and reports an error, although the action ran.
- **AtMostOncePerIntent: VIOLATED**. The shortest trace uses the double click. With double clicks excluded (`Approvals_singleClick.cfg`, 10 steps):
  1. The first `tb` call times out.
  2. The controller retries.
  3. Two cards with the same summary are now pending.
  4. The user approves both, and the action runs twice.

  After a server restart this also happens with one card at a time:
  1. The first action runs.
  2. The crash turns `tb`'s next poll into an error.
  3. The controller retries, and the user approves the new card.

  The user has no sign that the first request already ran.
- **What happens to the waiting `tb` when the server restarts** (the question in the task):
  - The pending approval is gone, because the `Map` is in memory.
  - The next poll either gets a refused connection (the server is still down) or a 404 with an empty body. In both cases `fetch(...).json()` throws. `tb` then stops with an unhandled promise rejection and a stack trace, not with its "not done" message.
  - Whether the action runs depends on the moment of the crash:
    - If the crash happened before the user approved, the action is lost. The card is gone from the dashboard.
    - If it happened after the side effect, the action ran, but the controller is told it failed.

  The controller's status also stays "needs-you / Approve: …" until its next Stop hook, because `onApprovalsChange` (`index.ts:438-443`) only fires on a change to the approvals `Map`.
- **NoExecWithoutApproval** passes for an honest `tb`. **With `ControllerMayBypass = TRUE` it is VIOLATED in one step.** `tb` sends `x-tb-actor: $TASK_ID` (`bin/tb:15`), and the server trusts the header. Any of these runs the action with no approval:
  - `TASK_ID=x tb send …`;
  - `curl` with the token from `~/.taskboard/token`, which the agent can read;
  - `tmux -L taskboard send-keys`.

  For a Claude Code controller, Claude Code's own permission prompts still apply to those commands. A Codex controller runs with network access on (`agents.ts:108`) and has no such check. The approval step therefore records the user's intent, but it does not enforce it.
- **Fixed: every property passes** (85 states; reachability was checked separately). The changes:
  - `decide()` sets a "running" state before it awaits the runner.
  - Approvals are written to disk. After a restart, a pending approval is pending again, and one that was running is reported as "unknown".
  - `tb` returns the approval id at once. The controller asks for the result later, and retries on connection errors.

---

## What this says about the design

These checks show that the problems come from the protocol, not from the language. Each failure listed below falls into one of two groups:

- the protocol design, which a port to Rust with the same design would keep;
- the Node/TypeScript runtime, or the way the code uses it.

### Failures that come from the protocol design (a Rust port would keep them)

- **Kill decisions made from a status that can be out of date** (NoKillMidTurn: immediate restart, `restartWhenDone`, the controller settings restart, `moveWhenDone`).
  - The server decides from its view, and the view lags behind the agent by at least one HTTP hook. For Codex, there is no prompt event at all.
  - Any design that decides "is it idle?" and then kills, as two steps, has this race.
  - The fix is to act at a moment when the agent cannot start a turn: inside the Stop hook for Claude Code (fix (a)), or through an "exit if idle" operation that the CLI would have to provide. Codex's notify is fire-and-forget, and SIGTERM to another terminal can always race with typing there, so those two cases cannot be made safe from the server alone.
- **Events are lost when the server is down, and nothing resynchronises the status** (StatusConverges). Hook scripts drop failed requests (`claude-hook.mjs:25`, `codex-notify.mjs:28`). Status for tmux-owned tasks is only ever changed by events. Fix: re-derive status from the transcript in `reconcile()` (fix (b)), or have the hook scripts write their events to disk for the server to read.
- **The lock ignores empty files, and its check and delete are separate** (MutualExclusion, HolderRecorded). The stale-file check reads, decides and then deletes, as three steps. An empty file counts as stale. And the startup work, including `reconcile()` and `startController()`, runs before `listen()`. A Rust port with the same file protocol has the same race. Fix: listen first, so the kernel enforces the lock (fixed variant), or hold an `flock` on the file for the whole life of the process.
- **Trusting pids from a file** (NoForeignSignal, EventuallyAlwaysUp in ServerInstance).
  - `stop.mjs` and `restartProduction()` signal whatever pid the file names.
  - `liveHolder()` accepts any process whose command line matches `server/index.ts`.
  - Fix: identify the server through the port or an HTTP call, not a pid.
- **Release rollback that depends on the release script staying alive and on a 30-second window** (Release). Fix: make "go back to the last healthy release" a job of the supervisor, not of the script.
- **"Tmux call failed" and "no session" are reported as the same result** (NoKillLiveOnListingError with transient failures; ControllerAlive with a broken listing). `tmuxQuiet()`, `listSessions()` and `hasSession()` turn every error into "nothing there" (`tmux.ts:16-18, 25, 34`). Today's fix added a second check. That check narrows the window, but the listing is still consulted in two places that disagree when it fails:
  - `reconcile()` (`index.ts:568`) treats a failed listing as "maybe present";
  - `startController()` (`agents.ts:99`) treats it as "present and alive".

  Returning an error value separate from "not found" would remove both counterexamples. This is a protocol and API choice. Rust's `Result` type makes it the default way to write it, but the same code could be written in TypeScript today.
- **Approvals held only in memory, with an unbounded synchronous wait in `tb`, and actor identity taken from a header** (AtMostOncePerIntent, ErrorMeansNotRun, the loss of an approval on restart, NoExecWithoutApproval). These are choices about where the data lives and whom the server trusts. The language does not change them.

### Failures that come from the Node/TypeScript runtime, or how the code uses it

- **`decide()` awaits the runner before it changes the state** (AtMostOncePerApproval, DeniedNeverRuns). This is a check-then-act across an `await`: another request is handled on the event loop while the first one waits. It is a JavaScript concurrency pattern. A Rust port with async handlers would have the same bug unless the state change is made before the await. The fix is one line: set the state to "running" before the `await`. This is not a reason to port.
- **Overlapping `reconcile()` passes.** `setInterval(reconcile, 2000)` (`index.ts:591`) does not wait for the previous async pass. A pass that is inside `restartTask()` or `startController()` can overlap with the next one. This is not in the model, but it is the same kind of issue: an async interleaving that is easy to write by accident in Node. A simple guard ("skip if a pass is still running") fixes it in either language.
- **No `flock` in the Node standard library.** This is why the lock is built from a PID file. In Rust (`fs2`, `fd-lock`) or with a Node native module, holding a kernel lock for the whole life of the process is simple. Listening on the port first gives the same guarantee in Node without any new dependency.
- **The `tb` crash on a 404 or refused connection** (`.json()` on an empty body). Error handling left out in a script. It has no connection to the runtime choice.

### Conclusion

None of the violated properties requires a port to fix. Every counterexample in the current code comes from one of these:

- a decision made from a view of the agent that can be out of date;
- a check and an action done as separate steps: the lock, `decide()`, the restart of the controller;
- state held only in memory, with no recovery after a restart: approvals, and statuses that depend on dropped events;
- errors treated as "not found".

A Rust port with the same protocol would reproduce all of them. The changes worth making first are all small:

- listen before the lock and before the startup work;
- act inside the Stop hook, not from `status`;
- resync status from transcripts;
- set the "running" state before awaiting the runner, and store approvals on disk;
- keep tmux errors separate from "no session";
- check a process before signalling it by the pid in a file;
- have the supervisor, not the release script, return to the last healthy release.

The Claude "fixed" variants of AgentLifecycle, and the fixed variants of ServerInstance, Release and Approvals, pass all their properties. The one exception is the separate stop-script finding (NoForeignSignal). What stays open for any language are these cases, which need the CLI to cooperate:

- Codex (NoKillMidTurn);
- moving a session from another terminal;
- the controller skipping approvals (approvals are not a security boundary between processes of the same Unix user).
