/-
The task status reducer: how hook events change a task's status (server/events.ts), plus the manual status
endpoint (server/index.ts:185-190) and the transcript-based status of sessions open in another terminal
(server/index.ts:482-484, fed by server/external.ts).

What is modelled per task (`Mem`):
* `status`: the task's status (store.ts:8).
* `started`: whether `turnStart` (events.ts:8) has an entry for the task.
* `blocked`: whether `blockedOnce` (events.ts:9) contains the task.
* `saved`: the value of `answerBeforeLog` (events.ts:10) for the task, if any.

What is abstracted:
* Times. The Stop hook's `logged` test (events.ts:62: the log file changed after the turn started) is an input of
  the Stop event. Codex transcript timing (events.ts:123-125) is folded into "the activity rule fired".
* Messages are character lists; `endsQ` is `endsWithQuestion` (events.ts:15) on ASCII whitespace.
* The `ask`, `now` and `statusSource` fields are not modelled; only `status`.
-/
import Taskboard.Basic

namespace Taskboard.Events
open Taskboard

/-- events.ts:15: `/\?\s*$/.test(s.trim())`. -/
def endsQ (m : Str) : Bool := (trim m).getLast? == some '?'

structure Mem where
  status : Status
  started : Bool
  blocked : Bool
  saved : Option Str
  deriving DecidableEq, Repr

structure Ctx where
  /-- the task is open in a UI window (events.ts:11) -/
  viewing : Bool
  /-- `t.role === 'controller'` -/
  controller : Bool
  deriving DecidableEq, Repr

/-- `notification_type` values of events.ts:51; `other` is every other value. -/
inductive NKind where
  | permissionPrompt | agentNeedsInput | elicitationDialog | other
  deriving DecidableEq, Repr

inductive Ev where
  | sessionStart                                                  -- events.ts:37-40
  | userPromptSubmit                                              -- events.ts:41-45
  | permissionRequest                                             -- events.ts:46-48
  | notification (k : NKind)                                      -- events.ts:49-54
  | postToolUse                                                   -- events.ts:55-57
  | stop (logged : Bool) (stopHookActive : Bool) (last : Str)     -- events.ts:58-74
  | stopFailure                                                   -- events.ts:75-78
  | codexTurnComplete (isTitle : Bool) (last : Str)               -- events.ts:83-93 (isTitle: the regex at :89)
  | bell                                                          -- events.ts:114-118 (Codex tasks only)
  | codexActivity                                                 -- events.ts:122-129, reached via index.ts:575-578
  | setStatus (s : Status)                                        -- POST /api/tasks/:id/status, index.ts:185-190
  deriving DecidableEq, Repr

/-- `finishedStatus` (events.ts:18-23). -/
def finished (st : Status) (msg : Str) (viewing : Bool) : Status :=
  if st = .review then .review
  else if endsQ msg then .needsYou
  else if viewing then .idle else .unread

/-- events.ts:70: `answerBeforeLog.get(t.id) || input.last_assistant_message || ''` (an empty saved answer is
falsy, so the new message is used). -/
def pickMsg (saved : Option Str) (last : Str) : Str :=
  match saved with
  | some m => if m.isEmpty then last else m
  | none => last

/-- The Stop hook asks for a log entry (events.ts:63). -/
def blocks (c : Ctx) (m : Mem) (logged sha : Bool) : Bool :=
  !logged && m.started && !c.controller && !sha && !m.blocked

/-- The reducer. `codexActivity` includes the gate of reconcile (index.ts:560 skips archived and parked tasks) and of
events.ts:125. `setStatus` only accepts idle, parked and archived (index.ts:187). -/
def step (c : Ctx) (m : Mem) : Ev → Mem
  | .sessionStart => if m.status = .suspended then { m with status := .idle } else m
  | .userPromptSubmit => { m with status := .working, started := true, blocked := false }
  | .permissionRequest => { m with status := .needsYou }
  | .notification k => if k ≠ .other ∧ m.status ≠ .needsYou then { m with status := .needsYou } else m
  | .postToolUse => if m.status = .needsYou then { m with status := .working } else m
  | .stop logged sha last =>
    if blocks c m logged sha then { m with blocked := true, saved := some last }
    else { m with status := finished m.status (pickMsg m.saved last) c.viewing, saved := none }
  | .stopFailure => { m with status := .stopped }
  | .codexTurnComplete isTitle last => if isTitle then m else { m with status := finished m.status last c.viewing }
  | .bell => { m with status := .needsYou }
  | .codexActivity =>
    if m.status = .unread ∨ m.status = .idle ∨ m.status = .needsYou then { m with status := .working } else m
  | .setStatus s => if s = .idle ∨ s = .parked ∨ s = .archived then { m with status := s } else m

def run (c : Ctx) (m : Mem) (evs : List Ev) : Mem := evs.foldl (step c) m

/-! ## (a) review -/

/-- **(a)** A task in `review` stays in `review` on any single Stop, blocked or not (events.ts:20). -/
theorem review_stays_on_stop (c : Ctx) (m : Mem) (logged sha : Bool) (last : Str) (h : m.status = .review) :
    (step c m (.stop logged sha last)).status = .review := by
  simp only [step]
  split
  · exact h
  · simp [finished, h]

/-- The comment at events.ts:19 says review is kept "until you act on it". That holds for one Stop, not across a
turn: a permission prompt during the turn moves the task to needs-you, the approved tool moves it to working, and
the Stop then finds no `review` to keep. The task ends `unread` although nobody acted on the document. -/
theorem review_lost_through_permission :
    let c : Ctx := { viewing := false, controller := false }
    let m : Mem := { status := .review, started := true, blocked := false, saved := none }
    (run c m [.permissionRequest, .postToolUse, .stop true false "Done.".toList]).status = .unread := by
  decide

/-! ## (b) questions -/

/-- **(b)** A Stop that is not turned into a log request, on a task not in review and with no saved answer,
yields needs-you exactly when the last message ends with "?". -/
theorem stop_question_needs_you (c : Ctx) (m : Mem) (logged sha : Bool) (last : Str)
    (hnb : blocks c m logged sha = false) (hr : m.status ≠ .review) (hs : m.saved = none) (hq : endsQ last = true) :
    (step c m (.stop logged sha last)).status = .needsYou := by
  simp [step, hnb, finished, hr, hs, pickMsg, hq]

/-- **(b) fails when a saved answer is left over from an earlier turn.** `answerBeforeLog` is set when the Stop
hook asks for a log entry (events.ts:65) and cleared only by a later Stop that is not blocked (events.ts:71).
`UserPromptSubmit` clears `blockedOnce` (events.ts:42) but not `answerBeforeLog`. If the turn that was asked for
a log never reaches a normal Stop (here: an API error, StopFailure; the same happens when the user interrupts the
agent, which sends no Stop), the old answer survives. The next turn's Stop shows the old question: the task
becomes needs-you although the new last message, "Tests pass.", is not a question. -/
theorem stale_saved_answer :
    let c : Ctx := { viewing := false, controller := false }
    let m : Mem := { status := .idle, started := false, blocked := false, saved := none }
    let evs := [Ev.userPromptSubmit, .stop false false "Shall I deploy to production?".toList, .stopFailure,
                .userPromptSubmit, .stop true false "Tests pass.".toList]
    endsQ "Tests pass.".toList = false ∧ (run c m evs).status = .needsYou := by
  decide

/-- The mirror case: a new question is hidden by an old statement. -/
theorem stale_saved_answer_hides_question :
    let c : Ctx := { viewing := false, controller := false }
    let m : Mem := { status := .idle, started := false, blocked := false, saved := none }
    let evs := [Ev.userPromptSubmit, .stop false false "Done, all tests pass.".toList, .stopFailure,
                .userPromptSubmit, .stop true false "Which branch should I use?".toList]
    (run c m evs).status = .unread := by
  decide

/-! ## (c) permission requests -/

/-- **(c)** PermissionRequest always yields needs-you, from every status, archived and parked included. -/
theorem permission_needs_you (c : Ctx) (m : Mem) : (step c m .permissionRequest).status = .needsYou := rfl

/-! ## (d) archived and parked -/

/-- Events that leave the status unchanged, from any status that is not suspended / needs-you. -/
theorem archived_kept_by (c : Ctx) (m : Mem) (h : m.status = .archived) :
    (step c m .sessionStart).status = .archived ∧
    (step c m .postToolUse).status = .archived ∧
    (step c m (.notification .other)).status = .archived ∧
    (step c m .codexActivity).status = .archived := by
  simp [step, h]

/-- **(d)** Hook events move an archived task out of the archive. Each of these events, when it reaches an
archived task, gives it an active status. -/
theorem archived_left_by (c : Ctx) (m : Mem) (h : m.status = .archived) :
    (step c m .userPromptSubmit).status = .working ∧
    (step c m .permissionRequest).status = .needsYou ∧
    (step c m (.notification .permissionPrompt)).status = .needsYou ∧
    (step c m .stopFailure).status = .stopped ∧
    (step c m .bell).status = .needsYou := by
  simp [step, h]

theorem finished_active (st : Status) (msg : Str) (v : Bool) (h : st ≠ .review) :
    finished st msg v ≠ .archived ∧ finished st msg v ≠ .parked := by
  cases hq : endsQ msg <;> cases v <;> simp [finished, h, hq]

/-- Every Stop that is not a log request takes the task out of the archive (and out of `parked`, which is
intended). -/
theorem stop_unarchives (c : Ctx) (m : Mem) (logged sha : Bool) (last : Str)
    (hnb : blocks c m logged sha = false) (h : m.status = .archived ∨ m.status = .parked) :
    (step c m (.stop logged sha last)).status ≠ .archived ∧ (step c m (.stop logged sha last)).status ≠ .parked := by
  have hr : m.status ≠ .review := by rcases h with h | h <;> simp [h]
  simp only [step, hnb]
  exact finished_active _ _ _ hr

/-- The same for the end of a Codex turn that is not a title turn (events.ts:90). -/
theorem codex_turn_unarchives (c : Ctx) (m : Mem) (last : Str) (h : m.status = .archived ∨ m.status = .parked) :
    (step c m (.codexTurnComplete false last)).status ≠ .archived ∧
    (step c m (.codexTurnComplete false last)).status ≠ .parked := by
  have hr : m.status ≠ .review := by rcases h with h | h <;> simp [h]
  simp only [step]
  exact finished_active _ _ _ hr

/-- How it happens in practice. `tb archive` (bin/tb:147) calls the status endpoint (index.ts:185-190), which sets
`archived` without ending the tmux session (only "End & archive", index.ts:269-272, kills it). An agent archived
mid-turn keeps running; its Stop then puts the task back on the lists as unread. -/
theorem tb_archive_mid_turn_comes_back :
    let c : Ctx := { viewing := false, controller := false }
    let m : Mem := { status := .working, started := true, blocked := false, saved := none }
    (run c m [.setStatus .archived, .stop true false "Finished the refactor.".toList]).status = .unread := by
  decide

/-- Parked ("Set aside"): the UI says the task "comes back by itself the next time the agent works or finishes a
turn" (web/src/App.tsx:251). For Claude Code this matches: a prompt or a finished turn brings it back. -/
theorem parked_comes_back (c : Ctx) (m : Mem) (_h : m.status = .parked) :
    (step c m .userPromptSubmit).status = .working ∧ (step c m .permissionRequest).status = .needsYou := by
  simp [step]

/-- For Codex, "works" does not bring a parked task back: the transcript-activity rule is skipped for parked tasks
(index.ts:560) and only applies to unread / idle / needs-you (events.ts:125). Only the end of the turn does. -/
theorem parked_codex_activity_ignored (c : Ctx) (m : Mem) (h : m.status = .parked) :
    (step c m .codexActivity).status = .parked := by
  simp [step, h]

/-! ## Sessions in another terminal -/

/-- index.ts:482-484: when the transcript shows a finished turn, the status becomes unread (or idle while viewed),
keeping unread / idle. -/
def elsewhereFinished (st : Status) (viewing : Bool) : Status :=
  if st = .unread ∨ st = .idle then st else if viewing then .idle else .unread

/-- The two paths that handle "the turn ended" disagree. With a hook (events.ts:18-23) a final question gives
needs-you and review is kept; from the transcript (index.ts:482-484) the same turn gives unread in both cases.
The same agent turn gets a different status depending on which terminal the session runs in. -/
theorem hook_and_transcript_disagree :
    finished .working "Should I merge it?".toList false = .needsYou ∧
    elsewhereFinished .working false = .unread ∧
    finished .review "Done.".toList false = .review ∧
    elsewhereFinished .review false = .unread := by
  decide

end Taskboard.Events
