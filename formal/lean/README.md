# Formal models of Taskboard's core logic (Lean 4)

This folder has Lean 4 models of five parts of the Taskboard server, with machine-checked proofs about them. It
exists to answer one question: is the core logic sound as it is, or should it be restructured or ported (for
example to Rust)? Some theorems below prove properties the code is meant to have. Others prove that a property
**fails** for the current or the old code, by giving a concrete counterexample that Lean evaluates.

A "model" here is a Lean function written to compute the same result as a piece of the TypeScript code. Each
definition cites the lines it models (`path:line`, relative to the repository root). The proofs are only as
faithful as the models. Each section says what a model leaves out.

## How to check

```sh
cd formal/lean
~/.elan/bin/lake build          # Lean 4.34.1 (lean-toolchain), core Lean only, no Mathlib
grep -rn -E "\bsorry\b|\badmit\b|native_decide|^axiom" Taskboard Taskboard.lean   # prints nothing
```

Result of a clean build (`lake clean && lake build`) on 2026-09-28:

```
✔ [2/9] Built Taskboard.Basic (249ms)
✔ [3/9] Built Taskboard.Status (878ms)
⚠ [4/9] Built Taskboard.Lock (1.0s)
⚠ [5/9] Built Taskboard.Accounts (970ms)
⚠ [6/9] Built Taskboard.Listing (1.1s)
✔ [7/9] Built Taskboard.Guard (2.1s)
✔ [8/9] Built Taskboard (198ms)
Build completed successfully (9 jobs).
```

`⚠` marks a module that built with warnings.

The 11 warnings are all style warnings:

- deprecated lemma names (`if_pos`, `if_false`, and similar)
- simp arguments that are not used
- one "try simp instead of simpa"

The `grep` for `sorry`, `admit`, `native_decide` and `axiom` finds nothing. `#print axioms` on the main theorems
lists only Lean's standard axioms (`propext`, `Classical.choice`, `Quot.sound`). Every counterexample is checked by
`decide`, which means the Lean kernel evaluates the model on the concrete input.

## Files

- `lakefile.toml`, `lean-toolchain`: the Lake project.
- `Taskboard/Basic.lean`: shared definitions:
  - strings as lists of characters (`Str`)
  - the `Status` type of `server/store.ts:8`
  - JavaScript `trim`
  - a substring test (`hasInfix`)
- `Taskboard/Listing.lean`: the tmux session listing (`server/tmux.ts:22-31`) and the reconcile decision
  (`server/index.ts:554-581`).
- `Taskboard/Lock.lean`: the single-server lock (`server/lock.ts`), as a transition system over any number of
  processes.
- `Taskboard/Status.lean`: the status reducer for hook events (`server/events.ts`), the manual status endpoint
  (`server/index.ts:185-190`), and the status of sessions open in another terminal (`server/index.ts:482-484`).
- `Taskboard/Accounts.lean`: automatic account choice, `pick()` (`server/accounts.ts:124-139`).
- `Taskboard/Guard.lean`: the PreToolUse guard (`server/hooks/guard.mjs`).

## 1. Session listing and reconcile (`Listing.lean`)

### What the code does

Every 2 seconds (`server/index.ts:591`), `reconcile()` asks tmux for all panes, using
`tmux list-panes -a -F <format>` (`server/tmux.ts:24`). The format prints 7 fields per pane:

- session name
- window activity
- bell flag
- pane pid
- pane dead flag
- alternate-screen flag
- mouse flag

`listSessions()` trims the output, splits it into lines, drops empty lines, and splits each line on a separator
(`server/tmux.ts:25-30`). `reconcile()` puts the records in a `Map` keyed by name (`server/index.ts:556`). For each
task it then decides whether to change the status (`server/index.ts:557-570`):

- An archived or parked task is skipped.
- A suspended task whose session is in the listing and not dead becomes `idle`.
- A task missing from the listing is first checked with `tmux has-session` (`server/index.ts:568`). It is marked
  `suspended` only if that also says the session does not exist.
- A task whose listing record has the dead flag set is marked `suspended`.

In the OLD format, fields were separated by a tab. Under launchd there is no UTF-8 locale, and tmux printed each
tab as `_`. The split on tab then produced one field per line: the whole line became the "name", so no task's
session name matched. Every task was marked suspended.

### What is modelled

- `Pane`: what tmux knows about a pane.
- `Info`: what the parser returns (`SessionInfo`, `server/tmux.ts:20`). A JavaScript `NaN` is modelled as `none`.
- `tmuxOutput`: the text tmux prints, one line per pane, each line ending in a newline.
- `listSessions sep`: the parser. `parseNum` is `Number(field)`; a missing field (`undefined`) gives NaN.
- `renderTab`: the rewrite of every tab to `_`.
- `lookupLast`: `new Map(...)`, where the last record with a given name wins.
- `reconcileNew`: the current decision, including the `has-session` confirmation.
- `reconcileOld`: the same decision without that confirmation. The old source is not in the repository; this is the
  behaviour described in the task.
- `World`: the real state of tmux. For each name it gives no session, a live session, or a session whose pane is
  dead.

### Theorems

- `listing_roundtrip_new` (**proved true**): for every list of panes, parsing what tmux prints with the `|~|`
  separator returns exactly the intended records, in order. The session names must satisfy `NameOK`:
  - they start with a non-whitespace character
  - they contain no `|`
  - they contain no newline

  Taskboard's names (`task-<n>`, `server/agents.ts:220`, `:264`; `tb-controller`, `server/agents.ts:96`) satisfy
  all three. The proof covers the number fields: the decimal text of every natural number parses back to that
  number.
- `listing_name_counterexample` (**proved**; shows the `NameOK` condition is needed): a session named `x|~` is
  parsed as `x`. The comment at `server/tmux.ts:22` says session names "never contain" the separator. That
  condition is not enough: `x|~` does not contain `|~|`, yet the separator's search finds `|~|` across the name's
  end. This cannot happen with the current `task-<n>` names.
- `listing_old` and `listing_old_names` (**proved**; the incident, part 1): with the OLD format and the
  tab-to-`_` rewrite, the parser returns one record per pane. Its name is the whole printed line, which always
  contains `_`. Its numbers are NaN and its dead flag is false.
- `incident_old` (**proved**; the incident, part 2): with the OLD format and the OLD reconcile, every task whose
  status is not archived, parked or suspended, and whose session name has no `_`, is marked suspended. This holds
  for every state of tmux, including when every session is running. This is the incident.
- `reconcile_never_suspends_live` (**proved true**, with one condition): if a session is live and `has-session`
  answers truthfully, `reconcileNew` never marks the task suspended, whatever the listing contains. The listing
  may leave the task out, garble names, repeat records or have wrong numbers. The one condition: the listing must
  not report this very name with the dead flag set.
- `reconcile_trusts_dead_flag` (**proved**; shows that condition is needed): a listing that reports a live session
  as dead makes reconcile suspend it. The dead flag is not confirmed.
- `incident_new_reconcile` (**proved true**): with the same broken OLD listing, the current reconcile leaves live
  tasks alone. The `has-session` check alone would have prevented the incident.
- `tmux_failure_suspends_all` (**proved**; a remaining weakness): `tmuxQuiet` (`server/tmux.ts:16-18`) turns
  every tmux failure into `null`. When a failure happens:
  - `listSessions` returns an empty list
  - `hasSession` returns false (`server/tmux.ts:34`)

  So if tmux cannot be run at all (binary not on `PATH`, socket error, any other error), every task that is not
  archived, parked or suspended is marked suspended. That includes tasks whose sessions are running. The
  `has-session` check does not help, because it goes through the same error path. This is the same symptom as the
  incident, with a different cause.
- `recovery_forgets_needs_you` (**proved**): the recovery at `server/index.ts:563-564` brings a suspended task
  back as `idle`, not as the status it had before. Consider a task in `needs-you`. One bad reconcile pass (for
  example a tmux error) marks it suspended, and the next good pass sets it to idle. The "needs you" signal is lost.

## 2. The lock (`Lock.lean`)

### What the code does

`acquire()` (`server/lock.ts:24-41`) makes sure only one Taskboard server runs per `~/.taskboard`. It works in
these steps:

1. It creates `server.pid` with `openSync(FILE, 'wx')`, which fails if the file exists.
2. It writes its pid into the file.
3. If the create failed, it reads the file with `liveHolder()` (`server/lock.ts:13-21`). If the file names a live
   Taskboard server, it gives up.
4. Otherwise it unlinks the file and tries again, at most 3 times.

"A process believes it holds the lock" means `acquire()` returned `null`. The process then continues as the server
(`server/index.ts:42-43`).

### What is modelled

A transition system over any number of processes, identified by natural numbers. A run is a list of steps. Each
step is one process doing one system call:

- `create`: `server/lock.ts:27`
- `write`: `server/lock.ts:28`
- `check`: `server/lock.ts:34`
- `unlink`: `server/lock.ts:38`
- `crash`: the process dies and the file stays
- `exit`: a clean exit, which runs the release handler at `server/lock.ts:45`

Steps of different processes can come in any order. The file records which process created it. This stands for
the inode: a process writes through the descriptor from its own create, so its write goes to its own file even if
that file was unlinked and replaced in the meantime.

There are three designs:

- OLD: read the file; if its holder is alive, exit; otherwise write the own pid. The read and the write are
  separate steps.
- NEW: the current `server/lock.ts`.
- KERNEL: a lock that the operating system releases when its owner dies, such as `flock(2)` or binding the TCP
  port. This is a proposal, not current code.

### Theorems

- `old_two_holders` (**proved**; OLD is unsafe): the run `read 0, read 1, write 0, write 1` ends with two live
  processes that both believe they hold the lock.
- `new_two_holders_after_crash` (**proved**; NEW is unsafe): the invariant "at most one live process believes it
  holds the lock" is **false** for the current code. The run `traceStale` is:
  1. Server 9 takes the lock and crashes.
  2. Servers 0 and 1 start. Both find the file, and both see that 9 is dead.
  3. Server 0 unlinks the file, creates its own, writes its pid, and holds the lock.
  4. Server 1 now runs its own unlink (`server/lock.ts:38`). That removes server 0's file.
  5. Server 1 creates a new file and holds the lock.

  The comment at `server/lock.ts:36-37` ("the next attempt sees it as a live holder") covers a winner that
  creates its file after the loser's unlink. It does not cover a winner that creates its file before the loser's
  unlink.
- `new_two_holders_empty_file` (**proved**; NEW is unsafe with no crash at all): the run `traceEmpty` is:
  1. Server 0 creates the file. The file is empty until server 0 writes its pid, which is a separate system call.
  2. In that gap, server 1's create fails and it reads the empty file.
  3. `JSON.parse('')` throws, so `liveHolder()` returns null, and server 1 unlinks the file.
  4. Server 1 creates a new file and holds the lock.
  5. Server 0's write goes to its unlinked file, and server 0 also holds the lock.

  This contradicts `server/lock.ts:2-3` ("two servers starting at the same moment cannot both take it").
- `new_safe_without_unlink` (**proved true**): in every run that has no unlink step, at most one process ever
  believes it holds the lock. The exclusive create alone is sound, and both failures above go through the unlink.
  Without the unlink, however, a crashed server's file would block every later server.
- `kernel_lock_safe` (**proved true**): for the KERNEL design, at most one live process believes it holds the
  lock. This holds for any number of processes, any interleaving, and any crashes.
- `kernel_lock_recovers` (**proved**): after the owner crashes, another process can take the KERNEL lock.

### Observations from reading the code (not proved)

- The damage from two holders is limited in time by the HTTP port. `server.listen` is the last step
  (`server/index.ts:596`), and it exits on `EADDRINUSE` (`server/index.ts:595`). Before that point, both servers
  run steps that change shared state:
  - the first `reconcile()` (`server/index.ts:582`)
  - the controller start (`server/index.ts:584-587`)
  - the task rewrite at `server/index.ts:36-37`, which runs even before `acquire()`
- Binding the port first, before any other work, would turn the port into the KERNEL lock that is modelled here.

## 3. Status reducer (`Status.lean`)

### What is modelled

`step ctx mem event` returns the task's new state. `Mem` holds these fields:

- `status`
- `started`: whether `turnStart` has an entry for the task (`server/events.ts:8`)
- `blocked`: whether `blockedOnce` contains the task (`server/events.ts:9`)
- `saved`: the task's `answerBeforeLog` value (`server/events.ts:10`)

The events are:

- the Claude Code hooks SessionStart, UserPromptSubmit, PermissionRequest, Notification, PostToolUse, Stop and
  StopFailure (`server/events.ts:36-78`)
- Codex turn completion (`server/events.ts:83-93`)
- the terminal bell (`server/events.ts:114-118`)
- Codex transcript activity, with the gate at `server/index.ts:560` and `server/events.ts:125`
- the manual status endpoint (`server/index.ts:185-190`)

The Stop event carries three inputs:

- `logged`: the result of the log-file test at `server/events.ts:62`
- `stop_hook_active`
- the last assistant message

`finished` is `finishedStatus` (`server/events.ts:18-23`). `endsQ` is `endsWithQuestion` (`server/events.ts:15`).

The model leaves these out:

- times
- the `ask`, `now` and `statusSource` fields
- Unicode whitespace

### Theorems

- (a) `review_stays_on_stop` (**proved true**): a task in `review` stays in `review` on any single Stop.
- (a) `review_lost_through_permission` (**proved**; the intent holds only for a single Stop): the comment at
  `server/events.ts:19` says `review` is kept "until you act on it". In this sequence nobody acts on the document,
  and the task still ends `unread`:
  1. PermissionRequest moves `review` to `needs-you`.
  2. PostToolUse moves it to `working`.
  3. Stop finds no `review` to keep and gives `unread`.
- (b) `stop_question_needs_you` (**proved true**, with conditions): a Stop gives `needs-you` exactly when the last
  message ends with `?`, provided that:
  - the Stop does not ask for a log entry
  - the task is not in `review`
  - no saved answer is left
- (b) `stale_saved_answer` and `stale_saved_answer_hides_question` (**proved**; a bug in the current code): the
  saved answer is handled like this:
  - It is set when the Stop hook asks for a log entry (`server/events.ts:65`).
  - It is cleared only by a later Stop that is not blocked (`server/events.ts:71`).
  - UserPromptSubmit clears `blockedOnce` but not the saved answer (`server/events.ts:42`).

  The bug appears when the turn that was asked for a log never reaches a normal Stop. Two ways this happens:
  - an API error, which sends StopFailure instead of Stop
  - the user interrupts the agent, which sends no Stop

  The old answer then survives into the next turn, and that turn's Stop uses it. Proved examples:
  - The new last message "Tests pass." gives `needs-you`, from the old "Shall I deploy to production?".
  - The new question "Which branch should I use?" gives `unread`, from the old statement.
- (c) `permission_needs_you` (**proved true**): PermissionRequest always gives `needs-you`, from every status,
  archived and parked included.
- (d) `archived_left_by`, `stop_unarchives`, `codex_turn_unarchives` (**proved**; the actual behaviour): hook
  events move an archived task out of the archive:
  - UserPromptSubmit gives `working`.
  - PermissionRequest gives `needs-you`.
  - An attention Notification gives `needs-you`.
  - StopFailure gives `stopped`.
  - The bell gives `needs-you`.
  - Every Stop that does not ask for a log entry, and every Codex turn end, gives `needs-you`, `idle` or `unread`.

  `archived_kept_by` lists the events that leave an archived task alone:
  - SessionStart
  - PostToolUse
  - other Notifications
  - Codex transcript activity
- (d) `tb_archive_mid_turn_comes_back` (**proved**; how the behaviour in (d) happens in practice, **flagged as a
  likely bug**): the two ways to archive a task behave differently:
  - `tb archive` (`bin/tb:147`) calls `POST /api/tasks/:id/status`, which sets `archived` without ending the tmux
    session (`server/index.ts:185-190`).
  - Only "End & archive" (`server/index.ts:269-272`) kills the session, and `killSession` ignores errors
    (`server/tmux.ts:70`).

  So an agent archived with `tb archive` in the middle of a turn keeps running. When the turn ends, its Stop puts
  the task back on the lists as `unread`. The UI and the reconcile loop treat archived as final: archived tasks are
  hidden from the lists, and reconcile skips them (`server/index.ts:560`). Nothing in the reducer checks for
  archived.
- `parked_comes_back` (**proved**; matches the UI): "Set aside" (`parked`) is described as coming back "by itself
  the next time the agent works or finishes a turn" (`web/src/App.tsx:251`). For Claude Code, a prompt or a
  finished turn does bring it back. Leaving `parked` on events is intended.
- `parked_codex_activity_ignored` (**proved**; a small mismatch with that description): for Codex, activity in
  the transcript does not bring a parked task back, because reconcile skips parked tasks (`server/index.ts:560`).
  Only the end of the turn does.
- `hook_and_transcript_disagree` (**proved**): there are two code paths for "the turn ended", and they give
  different statuses:
  - Through a hook (`server/events.ts:18-23`), a final question gives `needs-you`, and `review` is kept.
  - From the transcript of a session in another terminal (`server/index.ts:482-484`), the same turn gives
    `unread` in both cases.

## 4. Account choice (`Accounts.lean`)

### What is modelled

`pick ag running accounts` returns the chosen account and a flag that is true when the fallback was used. It
applies the four filters of `server/accounts.ts:128-132`:

- the account is not `limited`
- `fullUntil` is 0
- its running count is below `maxParallel`
- it is signed in

If no account passes, `pick` returns the fallback `defaultFor(agent)` (`server/accounts.ts:135`). Otherwise it
sorts with the comparator of `server/accounts.ts:137`:

1. fewest running tasks
2. then the lowest peak usage
3. then the default account first

`Array.prototype.sort` is stable, so `sort(...)[0]` is the first element, in the original order, that nothing
sorts before. `best` computes exactly that.

The model does not cover a NaN peak. In JavaScript, `peak` is a float and can be NaN; a NaN makes the comparator
inconsistent and the sort order unspecified.

### Theorems

- `pick_sound` (**proved true**): if `pick` does not fall back, the chosen account is in the list, is for the
  requested agent, and passes all four filters.
- `pick_complete` (**proved true**): if some account of the agent passes the filters, the fallback is not used.
- `pick_optimal` (**proved true**): no eligible account of the agent sorts before the choice:
  - none has fewer running tasks
  - with equal running counts, none has a lower peak
  - with both equal, if an eligible account is the default, the choice is the default

  The proof uses three facts about the comparator: it is irreflexive, it is transitive, and whenever `a` sorts
  before `c`, any `b` sorts after `a` or before `c`.
- `fallback_exceeds_cap` (**proved**): the fallback ignores every filter. The default account is returned even
  when it is at its limit and already runs `maxParallel` tasks, so `maxParallel` is not a cap.
- `concurrent_starts_exceed_cap` (**proved**; from reading `server/agents.ts:201-218`): `startTask` calls `pick`
  at `server/agents.ts:206`, and stores the task only at `server/agents.ts:218`, with `await`s in between. The
  running count (`runningOn`) only counts stored tasks. Two starts at the same time therefore both see the same
  counts, both choose the same account, and can put it one task over `maxParallel`.

## 5. The guard (`Guard.lean`)

### What is modelled

`deny pid cmd` models the decision of `server/hooks/guard.mjs`:

- `parts` is the split at `server/hooks/guard.mjs:23`.
- `r1` is the pkill/killall rule at `server/hooks/guard.mjs:26`, modelled exactly for ASCII text, including the
  `\b` word boundaries and the case-insensitive name list.
- The other rules (`server/hooks/guard.mjs:28`, `:30`, `:32`, `:36`, `:38`, `:41`) are modelled by
  over-approximations. Each model rule fires whenever the real regular expression fires, and sometimes more often.

Because of this, both kinds of conclusion carry over to the real guard:

- "denied" is only concluded through `r1`, which is exact.
- "allowed" by the model means allowed by the real guard, because every model rule fires at least as often as the
  real one.

### Theorems

- `r1_denies` (**proved true**): any command with a part that contains the word `pkill` or `killall` together
  with one of the listed names (`server/index`, `taskboard`, `tsx`, `node`, `npx`) is denied, for every pid.
  Instances:
  - `incident_command_denied`: `cd ~/taskboard && pkill -f "tsx server/index.ts"`
  - `killall_node_denied`: `killall node`
- Commands that would stop the real server and are **allowed**, each proved for every pid made of digits:
  - `allowed_kill_cat_pidfile`: `kill $(cat ~/.taskboard/server.pid)`. The pid rule only matches the pid written
    out as digits.
  - `allowed_pgrep_xargs`: `pgrep -f server/index | xargs kill`. The kill is in another part of the command, and
    `pgrep` is not `pkill`.
  - `allowed_kill_pgrep`: `kill $(pgrep -f server/index)`
  - `allowed_pkill_index`: `pkill -f index.ts`. This pattern matches the server's command line, but none of the
    listed names.
  - `allowed_pkill_regex`: `pkill -f 'server[/]index'`. `pkill` reads its pattern as a regular expression, so
    this matches the server, but the text is not `server/index`.
  - `allowed_script`: `bash ./stop-servers.sh`. The guard never sees a script's contents.

### Cross-check against the real guard

The real `guard.mjs` was run with a scratch `TASKBOARD_DIR` holding a fake `server.pid` with pid 54321. The
commands were passed as JSON text only; nothing was executed. The real guard denied these:

- `cd ~/taskboard && pkill -f "tsx server/index.ts"`
- `killall node`
- `kill 54321`

It allowed all six commands in the "allowed" list above. This is the same answer as the model gives.

Other limits, from reading the code:

- The guard runs only for the Bash tool of Claude Code sessions. Codex agents have no guard.
- `TASKBOARD_DIR` in the agent's environment decides which pid file the guard reads (`server/hooks/guard.mjs:17`).

## What is out of scope

- Timing:
  - the 2-second reconcile interval
  - the 20-second and 1.5-second Codex windows (`server/events.ts:123-125`)
  - the 90-second screen check (`server/index.ts:573`)
  - the 60-second account status cache
- Interleaving between a hook request and a reconcile pass that runs at the same time. Both are `async` and call
  `store.update` on the same task objects. For example, a Stop hook that is already in flight when "End & archive"
  runs can un-archive the task. This is the sequence in (d), but the concurrency itself is not modelled.
- `keepController` (`server/index.ts:519-545`), `screenCheck` (`server/events.ts:104-110`), and the transcript
  parsers in `server/external.ts:26-69`. Only the "finished" branch of `watchElsewhere` is modelled.
- JavaScript regular expressions beyond ASCII, and Unicode whitespace in `trim`.
- `Number()` on text that is not plain digits (for example `" 1"` or `"0x10"`). The model returns NaN for any
  non-digit text.
- Pid reuse in `liveHolder()` (the `ps` check at `server/lock.ts:18-19`).
- Whether `tmux` really rewrites a tab as `_` under a non-UTF-8 locale. This is taken as given from the incident.

## What this says about the design

The proofs sort the findings into two groups: problems a Rust port would remove by itself, and problems that are
in the logic or the protocol and would be carried over unchanged.

### Problems a port to Rust (with its type system) would prevent or make hard to write

- **Silent mis-parse of the listing (the incident).** In TypeScript, a line with too few fields still produces a
  record: `Number(undefined)` is `NaN`, `undefined === '1'` is false, and the name is the whole line
  (`listing_old`). In Rust, the fields would be destructured with a length check and parsed with
  `str::parse::<u64>()`, which returns a `Result`. A line with the wrong shape would become an error value, not a
  record with a wrong name.
- **Error and absence as one value.** `tmuxQuiet` returns `null` both for "tmux failed" and, through
  `listSessions`, for an empty listing (`tmux_failure_suspends_all`). In Rust the natural types are
  `Result<Vec<Session>, TmuxError>` and `Result<bool, TmuxError>`. With those types, "tmux failed" is a separate
  case that the compiler makes reconcile handle.
- **Comparator on floats.** `f64` does not implement `Ord`, so a Rust sort must use `total_cmp` or an integer key.
  That removes the NaN case left out of section 4.
- **Per-turn state kept in three maps.** `turnStart`, `blockedOnce` and `answerBeforeLog` are three separate maps
  that must be reset together, and one of them is not (`stale_saved_answer`). One `enum` per task, with the saved
  answer inside the "asked for a log" variant, would make a leftover answer impossible to represent. Rust makes
  this style the normal one. TypeScript discriminated unions can also express it, so this is a restructuring that
  Rust encourages, not something only Rust can do.
- **Exhaustive (status, event) handling.** The reducer switches on the event and ignores the current status
  (`archived_left_by`). A Rust `match (status, event)` must cover every pair, which forces a decision for
  `archived` and `parked` on each event. TypeScript can get the same check with `never`-based exhaustiveness.

### Problems a port would not prevent

- **The lock races** (`new_two_holders_after_crash`, `new_two_holders_empty_file`, `old_two_holders`). They come
  from how file-system calls interleave between processes. They would occur the same way in Rust. The fix is a
  different protocol: a lock the kernel releases on process death (`kernel_lock_safe`). Rust's standard library
  has `File::lock` (flock), and Node has no flock in core, so a port makes that fix easier to write. The same fix
  is available in Node by binding the HTTP port before doing any other work.
- **Trusting the dead flag without confirmation** (`reconcile_trusts_dead_flag`), and **recovery to `idle`
  instead of the previous status** (`recovery_forgets_needs_you`). These are decisions of the reconcile logic.
- **Archived tasks leaving the archive on events** (`tb_archive_mid_turn_comes_back`), and **review being lost
  during a turn** (`review_lost_through_permission`). These are missing rules, not type errors.
- **Two "turn ended" code paths that disagree** (`hook_and_transcript_disagree`). The fix is to use one function
  for both paths.
- **`pick` races and the fallback that ignores `maxParallel`** (`concurrent_starts_exceed_cap`,
  `fallback_exceeds_cap`). Ownership rules do not prevent logical races between two async tasks. The fix is to
  count or reserve the slot in the same critical section as the choice.
- **Guard gaps** (`allowed_*`). A text filter over shell commands cannot see through `$(...)`, pipes to `xargs`,
  regular-expression patterns or scripts in any language. A stronger protection would work at the process level:
  for example, run the real server under a user or in a process group that agents cannot signal, or make the
  test servers identifiable so that a kill by name cannot match the real one.

### Summary

Most of the core logic, as modelled, does what it is meant to do:

- The new listing format round-trips.
- `reconcile` with `has-session` protects live sessions.
- `pick` is sound, complete and optimal.
- PermissionRequest and review-on-Stop behave as intended.

The unsafe parts are:

- the lock protocol
- the leftover saved answer in the Stop hook
- the error path of `tmuxQuiet`
- archived tasks returning on hook events

Each of these can be fixed locally in TypeScript. A Rust port would prevent the class of bug behind the incident
(silent mis-parse, and errors that look like empty results). It would not fix the lock or the status rules without
the same redesign.
