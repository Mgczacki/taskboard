---------------------------- MODULE AgentLifecycle ----------------------------
(***************************************************************************)
(* One Taskboard task: the real state of its agent, the hook events the    *)
(* agent's CLI sends to the server, and the server's view of it (status),  *)
(* updated by those events and by reconcile() every 2 s.                   *)
(*                                                                         *)
(* Role = "worker": a task running in Taskboard's tmux (index.ts:554-580). *)
(* Role = "controller": the controller task, kept alive by keepController  *)
(*   (index.ts:519-545) and startController (agents.ts:90-113).            *)
(* Role = "elsewhere": a session open in another terminal that Taskboard  *)
(*   follows through its transcript (watchElsewhere, index.ts:466-503) and *)
(*   moves into tmux when its turn ends (moveWhenDone, index.ts:497-502).  *)
(*                                                                         *)
(* Kind = "claude": Claude Code hooks, sent by server/hooks/claude-hook.mjs *)
(*   over HTTP.  Claude Code waits for each hook to finish (the script     *)
(*   gives up after 4 s, claude-hook.mjs:21), so the agent does not move   *)
(*   on while one of its events is in flight.                              *)
(* Kind = "codex": no prompt event.  Codex runs its notify program at the  *)
(*   end of a turn without waiting for it (codex-notify.mjs); an approval  *)
(*   request rings the terminal bell (events.ts:114-118); a new turn is    *)
(*   seen only when reconcile() finds the transcript file changed          *)
(*   (events.ts:122-129).                                                  *)
(*                                                                         *)
(* Code = "old": reconstruction of the code before today's fix, from the   *)
(*   task description and the comments at agents.ts:97-98 and             *)
(*   index.ts:562,567: no has-session confirmation, no recovery of a       *)
(*   suspended task whose session runs, and startController() kills an    *)
(*   existing session that is missing from the listing.                    *)
(* Code = "new": the code as it is now.                                    *)
(* Code = "fixed": proposals, not in the code:                             *)
(*   (a) "restart after the turn" and "restart the controller with new    *)
(*       settings" are done inside the Stop hook request, while Claude    *)
(*       Code waits for the hook, instead of by reconcile() from status;  *)
(*   (b) reconcile() also reads the transcript of tmux-owned sessions     *)
(*       (as external.ts does for other terminals) and corrects status.   *)
(*                                                                         *)
(* Listing = "oldBug": tmux list-panes output never parses (the launchd    *)
(*   locale bug: listSessions() returns []), has-session works.            *)
(* Listing = "transient": any single list-panes or has-session call may    *)
(*   fail (tmuxQuiet() turns every error into "no sessions" / false,       *)
(*   tmux.ts:16-18,25,34), but a pass with both working keeps coming       *)
(*   (fairness).                                                           *)
(* Listing = "ok": tmux calls never fail.                                  *)
(*                                                                         *)
(* Statuses "idle" and "unread" are merged into "idle": every check        *)
(* modelled here treats them the same (index.ts:207,217,528,572).         *)
(* Abstracted away: time except the controller's 60 s restart limit       *)
(* (rateOK), the log-entry Stop "block" (events.ts:63-67), questions that  *)
(* make a finished turn "needs-you", review/parked/archived/stopped,      *)
(* SessionStart, screenCheck, several tasks at once, overlapping           *)
(* reconcile() passes.                                                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, TLC

CONSTANTS Role, Kind, Code, Listing, UIOpensSuspended,
          MaxPrompts, MaxCrashes, MaxExits, MaxRequests, MaxChanges, MaxFaults

VARIABLES
  proc,          \* real agent: "none" (no tmux session), "idle", "turn", "approval" (waiting for the user), "exited" (pane dead)
  hookQ,         \* hook events on their way to the server, oldest first
  trSeen,        \* Codex: the transcript changed after the last notify/bell event
  tr,            \* elsewhere: what the transcript tail says: "finished" or "busy" (lags behind proc)
  srvUp,         \* the Taskboard server process is running
  status,        \* the server's view: "working", "needs", "idle", "suspended"
  restartWD,     \* task.restartWhenDone (index.ts:217)
  moveWD,        \* task.moveWhenDone (index.ts:207)
  moved,         \* elsewhere: the session has been moved into tmux
  settingsStale, \* controller: launchedAs differs from controllerLaunchKey (index.ts:528)
  rateOK,        \* controller: more than 60 s since controllerStartedAt (index.ts:522,528)
  badKill,       \* history: the first session kill that broke a property, with its cause
  ctlGen,        \* flips at every controller (re)launch
  prompts, crashes, exits, requests, changes,
  asks,          \* approval requests so far (bounded by MaxPrompts)
  faults         \* reconcile passes so far in which a tmux call failed (Listing = "transient")

vars == <<proc, hookQ, trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK,
          badKill, ctlGen, prompts, crashes, exits, requests, changes, asks, faults>>

Live == proc \in {"idle", "turn", "approval"}
MidTurn == proc \in {"turn", "approval"}
Owned == Role # "elsewhere" \/ moved            \* runs in Taskboard's tmux, sends hooks
Blocking == Kind = "claude"                       \* the CLI waits for its hook to finish

TypeOK ==
  /\ proc \in {"none", "idle", "turn", "approval", "exited"}
  /\ hookQ \in Seq({"UPS", "Perm", "PostTool", "Stop", "Done", "Bell"}) /\ Len(hookQ) <= 2
  /\ trSeen \in BOOLEAN /\ tr \in {"finished", "busy"}
  /\ srvUp \in BOOLEAN /\ status \in {"working", "needs", "idle", "suspended"}
  /\ restartWD \in BOOLEAN /\ moveWD \in BOOLEAN /\ moved \in BOOLEAN
  /\ settingsStale \in BOOLEAN /\ rateOK \in BOOLEAN
  /\ badKill \in {"none", "afterTurn", "restartNow", "ctlSettings", "move", "listing", "falseSuspend"}
  /\ ctlGen \in {0, 1}

Init ==
  /\ proc = "idle" /\ hookQ = <<>> /\ trSeen = FALSE /\ tr = "finished"
  /\ srvUp = TRUE /\ status = "idle"
  /\ restartWD = FALSE /\ moveWD = FALSE /\ moved = FALSE
  /\ settingsStale = FALSE /\ rateOK = TRUE
  /\ badKill = "none" /\ ctlGen = 0
  /\ prompts = 0 /\ crashes = 0 /\ exits = 0 /\ requests = 0 /\ changes = 0 /\ faults = 0 /\ asks = 0

\* ---------------------------------------------------------------------------
\* Killing the session and starting the agent again on the same conversation:
\* restartTask (index.ts:548-552), resumeTask (agents.ts:230-242), startController
\* (agents.ts:99-112), takeOver (agents.ts:275-287).  The kill also ends any hook
\* process of the old agent, so its event is lost.  The new agent is idle and the
\* server sets status idle (agents.ts:112, 241).
BadCause(cause) ==
  \/ cause \in {"afterTurn", "restartNow", "ctlSettings", "move"} /\ MidTurn   \* an "after the turn" action hit a running turn
  \/ cause \in {"listing", "falseSuspend"} /\ Live               \* a live agent killed because of a wrong listing/status
Relaunch(cause) ==
  /\ badKill' = IF badKill = "none" /\ BadCause(cause) THEN cause ELSE badKill
  /\ proc' = "idle" /\ status' = "idle" /\ hookQ' = <<>> /\ trSeen' = FALSE
  /\ ctlGen' = IF Role = "controller" THEN 1 - ctlGen ELSE ctlGen
  /\ settingsStale' = FALSE                          \* agents.ts:112 records the new launchedAs

\* the listing outcomes a reconcile() pass can see in this Listing mode
ListOK == CASE Listing = "oldBug" -> {FALSE} [] Listing = "transient" -> BOOLEAN [] Listing = "ok" -> {TRUE}
HasOK  == CASE Listing = "oldBug" -> {TRUE}  [] Listing = "transient" -> BOOLEAN [] Listing = "ok" -> {TRUE}

\* ---------------------------------------------------------------------------
\* The agent (the user or the controller types; the model works).  No fairness:
\* the user may stop at any time.
Enq(e) == hookQ' = Append(hookQ, e)
CanAct == ~Blocking \/ ~Owned \/ hookQ = <<>>
Room == Len(hookQ) < 2

Prompt ==
  /\ proc = "idle" /\ CanAct /\ Room /\ prompts < MaxPrompts
  /\ proc' = "turn" /\ prompts' = prompts + 1
  /\ IF Owned /\ Kind = "claude" THEN Enq("UPS") ELSE UNCHANGED hookQ     \* UserPromptSubmit
  /\ trSeen' = FALSE
  /\ UNCHANGED <<tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, crashes, exits, requests, changes, faults, asks>>
\* Codex writes the new prompt/tool records to its transcript file (not while it waits for an approval)
TranscriptWrite ==
  /\ Kind = "codex" /\ Owned /\ proc = "turn" /\ ~trSeen
  /\ trSeen' = TRUE
  /\ UNCHANGED <<proc, hookQ, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>
AskApproval ==
  /\ proc = "turn" /\ CanAct /\ Room /\ asks < MaxPrompts
  /\ proc' = "approval" /\ asks' = asks + 1
  /\ IF Owned THEN Enq(IF Kind = "claude" THEN "Perm" ELSE "Bell") ELSE UNCHANGED hookQ   \* PermissionRequest / bell
  /\ UNCHANGED <<trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults>>
ApproveInTerminal ==
  /\ proc = "approval" /\ CanAct /\ Room
  /\ proc' = "turn"
  /\ IF Owned /\ Kind = "claude" THEN Enq("PostTool") ELSE UNCHANGED hookQ
  /\ UNCHANGED <<trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>
FinishTurn ==
  /\ proc = "turn" /\ CanAct /\ Room
  /\ proc' = "idle"
  /\ IF Owned THEN Enq(IF Kind = "claude" THEN "Stop" ELSE "Done") ELSE UNCHANGED hookQ     \* Stop / notify
  /\ UNCHANGED <<trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>
AgentExits ==
  /\ Live /\ Owned /\ exits < MaxExits
  /\ proc' = "exited" /\ exits' = exits + 1 /\ hookQ' = <<>>
  /\ UNCHANGED <<trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, requests, changes, faults, asks>>
\* elsewhere: the transcript file catches up with the agent
TrFlush ==
  /\ Role = "elsewhere" /\ ~moved
  /\ tr # (IF proc = "idle" THEN "finished" ELSE "busy")
  /\ tr' = IF proc = "idle" THEN "finished" ELSE "busy"
  /\ UNCHANGED <<proc, hookQ, trSeen, srvUp, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>

\* ---------------------------------------------------------------------------
\* A hook event reaches the server, or is dropped because the server is down
\* (claude-hook.mjs:25, codex-notify.mjs:28 swallow the error).  events.ts:33-93.
Apply(e) ==
  CASE e = "UPS"      -> "working"                                          \* events.ts:41-43
    [] e = "Perm"     -> "needs"                                            \* events.ts:46-47
    [] e = "PostTool" -> IF status = "needs" THEN "working" ELSE status     \* events.ts:55-56
    [] e = "Stop"     -> "idle"                                             \* events.ts:58-72, finishedStatus
    [] e = "Done"     -> "idle"                                             \* events.ts:83-92
    [] e = "Bell"     -> "needs"                                            \* events.ts:114-118
StopTimeRestart(e) ==  \* Code "fixed" (a): act inside the Stop / notify request
  /\ Code = "fixed" /\ e \in {"Stop", "Done"}
  /\ (restartWD \/ (Role = "controller" /\ settingsStale))
Deliver ==
  /\ hookQ # <<>>
  /\ LET e == Head(hookQ) IN
       IF srvUp /\ StopTimeRestart(e)
         THEN /\ Relaunch(IF Role = "controller" THEN "ctlSettings" ELSE "afterTurn")
              /\ restartWD' = FALSE
              /\ UNCHANGED <<tr, srvUp, moveWD, moved, rateOK, prompts, crashes, exits, requests, changes, faults, asks>>
         ELSE /\ hookQ' = Tail(hookQ)
              /\ status' = IF srvUp THEN Apply(e) ELSE status
              /\ trSeen' = IF srvUp /\ e \in {"Done", "Bell"} THEN FALSE ELSE trSeen   \* lastCodexEvent = now
              /\ UNCHANGED <<proc, tr, srvUp, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>

\* ---------------------------------------------------------------------------
\* The server process.
ServerCrash ==
  /\ srvUp /\ crashes < MaxCrashes
  /\ srvUp' = FALSE /\ crashes' = crashes + 1
  /\ UNCHANGED <<proc, hookQ, trSeen, tr, status, restartWD, moveWD, moved, settingsStale, rateOK, badKill, ctlGen, prompts, exits, requests, changes, faults, asks>>

\* startController (agents.ts:90-113), with the listing outcomes lo (list-panes) and ho (has-session)
StartCtl(lo, ho) ==
  LET hasS == ho /\ proc # "none"
      listed == lo /\ proc # "none"
      dead == proc = "exited"
  IN IF hasS
       THEN IF listed /\ ~dead THEN UNCHANGED <<proc, status, hookQ, trSeen, badKill, ctlGen, settingsStale>>
            ELSE IF listed /\ dead THEN Relaunch("dead")
            ELSE IF Code = "old" THEN Relaunch("listing")                \* old: missing from the list -> replaced
            ELSE UNCHANGED <<proc, status, hookQ, trSeen, badKill, ctlGen, settingsStale>> \* agents.ts:99: `if (!s || !s.dead) return t`
       ELSE IF proc = "none" THEN Relaunch("none")
       ELSE UNCHANGED <<proc, status, hookQ, trSeen, badKill, ctlGen, settingsStale>>     \* new-session fails: duplicate session

\* transient tmux failures are bounded by MaxFaults, so that from some point on tmux answers
Fault(lo, ho) == Listing = "transient" /\ ~(lo /\ ho)
Allowed(lo, ho) == Fault(lo, ho) => faults < MaxFaults
CountFault(lo, ho) == faults' = IF Fault(lo, ho) THEN faults + 1 ELSE faults

\* index.ts:582-587: first reconcile, then startController when autostart is on
ServerBoot ==
  /\ ~srvUp /\ srvUp' = TRUE
  /\ IF Role = "controller"
       THEN \E lo \in ListOK, ho \in HasOK : Allowed(lo, ho) /\ StartCtl(lo, ho) /\ rateOK' = FALSE /\ CountFault(lo, ho)
       ELSE UNCHANGED <<proc, status, hookQ, trSeen, badKill, ctlGen, rateOK, settingsStale, faults, asks>>
  /\ UNCHANGED <<tr, restartWD, moveWD, moved, prompts, crashes, exits, requests, changes, asks>>

\* 60 s pass (controllerStartedAt, index.ts:522,528)
Tick ==
  /\ ~rateOK /\ rateOK' = TRUE
  /\ UNCHANGED <<proc, hookQ, trSeen, tr, srvUp, status, restartWD, moveWD, moved, settingsStale, badKill, ctlGen, prompts, crashes, exits, requests, changes, faults, asks>>

\* ---------------------------------------------------------------------------
\* reconcile() for a tmux-owned task, index.ts:560-579
ViewOf(p) == CASE p = "turn" -> "working" [] p = "approval" -> "needs" [] p = "idle" -> "idle" [] OTHER -> "suspended"
ReconcileWorker(lo, ho) ==
  LET listed == lo /\ proc # "none"
      dead == proc = "exited"
      hasS == ho /\ proc # "none"
      Same == UNCHANGED <<proc, hookQ, trSeen, status, restartWD, badKill, ctlGen, settingsStale>>
      SetStatus(x) == status' = x /\ UNCHANGED <<proc, hookQ, trSeen, restartWD, badKill, ctlGen, settingsStale>>
  IN
  IF status = "suspended"
    THEN IF Code # "old" /\ listed /\ ~dead THEN SetStatus("idle") ELSE Same           \* index.ts:563-566
  ELSE IF ~listed /\ Code # "old" /\ hasS THEN Same                                     \* index.ts:568
  ELSE IF ~listed THEN SetStatus("suspended")                                           \* index.ts:569
  ELSE IF dead THEN SetStatus("suspended")                                              \* index.ts:570
  ELSE IF Code # "fixed" /\ restartWD /\ status = "idle"
    THEN Relaunch("afterTurn") /\ restartWD' = FALSE                                    \* index.ts:572
  ELSE IF Kind = "codex" /\ trSeen /\ status \in {"idle", "needs"}
    THEN status' = "working" /\ trSeen' = FALSE /\ UNCHANGED <<proc, hookQ, restartWD, badKill, ctlGen, settingsStale>>  \* index.ts:575-578
  ELSE IF Code = "fixed" /\ hookQ = <<>> /\ status # ViewOf(proc)
    THEN SetStatus(ViewOf(proc))                                                        \* proposal (b)
  ELSE Same

\* keepController(), index.ts:519-533
ReconcileController(lo, ho) ==
  LET listed == lo /\ proc # "none"
      dead == proc = "exited"
  IN
  IF ~listed \/ dead
    THEN IF rateOK THEN rateOK' = FALSE /\ StartCtl(lo, ho)
         ELSE UNCHANGED <<proc, hookQ, trSeen, status, badKill, ctlGen, rateOK, settingsStale>>
  ELSE IF Code # "fixed" /\ settingsStale /\ status = "idle" /\ rateOK
    THEN rateOK' = FALSE /\ Relaunch("ctlSettings")
  ELSE UNCHANGED <<proc, hookQ, trSeen, status, badKill, ctlGen, rateOK, settingsStale>>

\* watchElsewhere(), index.ts:473-502 (the other terminal's process stays alive here)
ReconcileElsewhere ==
  LET view == IF tr = "finished" THEN "idle" ELSE "working" IN
  IF moveWD /\ tr = "finished"
    THEN Relaunch("move") /\ moved' = TRUE /\ moveWD' = FALSE                          \* takeOver: SIGTERM, resume in tmux
    ELSE status' = view /\ UNCHANGED <<proc, hookQ, trSeen, badKill, ctlGen, moved, moveWD, settingsStale>>

Reconcile(lo, ho) ==
  /\ srvUp
  /\ IF Role = "controller" THEN ReconcileController(lo, ho) /\ UNCHANGED <<restartWD, moveWD, moved>>
     ELSE IF Owned THEN ReconcileWorker(lo, ho) /\ UNCHANGED <<rateOK, moveWD, moved>>
     ELSE ReconcileElsewhere /\ UNCHANGED <<rateOK, restartWD>>
  /\ Allowed(lo, ho) /\ CountFault(lo, ho)
  /\ UNCHANGED <<tr, srvUp, prompts, crashes, exits, requests, changes, asks>>
ReconcileAny == \E lo \in ListOK, ho \in HasOK : Reconcile(lo, ho)
ReconcileGood == Reconcile(TRUE \in ListOK, TRUE \in HasOK)   \* a pass in which tmux answered

\* ---------------------------------------------------------------------------
\* The user on the dashboard.
\* POST /api/tasks/:id/restart {when:'after-turn'} (index.ts:213-219).  Code "fixed": restart at once only a
\* session tmux reports dead or missing (as in proposal (c)); otherwise wait for the next Stop hook.
RequestRestart ==
  /\ srvUp /\ Role = "worker" /\ ~restartWD /\ requests < MaxRequests
  /\ requests' = requests + 1
  /\ IF Code = "fixed"
       THEN IF status = "suspended" /\ proc \in {"none", "exited"} THEN Relaunch("afterTurn") /\ UNCHANGED restartWD
            ELSE restartWD' = TRUE /\ UNCHANGED <<proc, hookQ, trSeen, status, badKill, ctlGen, settingsStale>>
     ELSE IF status \notin {"idle", "suspended"}
       THEN restartWD' = TRUE /\ UNCHANGED <<proc, hookQ, trSeen, status, badKill, ctlGen, settingsStale>>
       ELSE Relaunch("restartNow") /\ UNCHANGED restartWD
  /\ UNCHANGED <<tr, srvUp, moveWD, moved, rateOK, prompts, crashes, exits, changes, faults, asks>>
\* POST /api/tasks/:id/takeover {when:'after-turn'} (index.ts:203-211)
RequestMove ==
  /\ srvUp /\ Role = "elsewhere" /\ ~moved /\ ~moveWD /\ requests < MaxRequests
  /\ requests' = requests + 1
  /\ IF status # "idle"
       THEN moveWD' = TRUE /\ UNCHANGED <<proc, hookQ, trSeen, status, badKill, ctlGen, moved, settingsStale>>
       ELSE Relaunch("move") /\ moved' = TRUE /\ UNCHANGED moveWD
  /\ UNCHANGED <<tr, srvUp, restartWD, rateOK, prompts, crashes, exits, changes, faults, asks>>
\* PATCH /api/info (machine name / Remote Control) -> launchedAs differs (index.ts:144-153)
ChangeSettings ==
  /\ srvUp /\ Role = "controller" /\ changes < MaxChanges
  /\ settingsStale' = TRUE /\ changes' = changes + 1
  /\ UNCHANGED <<proc, hookQ, trSeen, tr, srvUp, status, restartWD, moveWD, moved, rateOK, badKill, ctlGen, prompts, crashes, exits, requests, faults, asks>>
\* Opening a suspended task in the dashboard resumes it (web/src/components/TaskPanel.tsx:27 -> resumeTask,
\* which kills an existing session first, agents.ts:238).  Code "fixed" (c), a proposal: resumeTask kills only a
\* session whose pane tmux reports dead; a running one (or a failed tmux call) only sets status idle.
OpenSuspended ==
  /\ UIOpensSuspended /\ srvUp /\ Role = "worker" /\ status = "suspended"
  /\ IF Code = "fixed" /\ proc \notin {"none", "exited"}
       THEN status' = "idle" /\ UNCHANGED <<proc, hookQ, trSeen, badKill, ctlGen, settingsStale>>
       ELSE Relaunch("falseSuspend")
  /\ UNCHANGED <<tr, srvUp, restartWD, moveWD, moved, rateOK, prompts, crashes, exits, requests, changes, faults, asks>>

\* ---------------------------------------------------------------------------
Next ==
  \/ Prompt \/ TranscriptWrite \/ AskApproval \/ ApproveInTerminal \/ FinishTurn \/ AgentExits \/ TrFlush
  \/ Deliver \/ ServerCrash \/ ServerBoot \/ Tick \/ ReconcileAny
  \/ RequestRestart \/ RequestMove \/ ChangeSettings \/ OpenSuspended

Fairness ==
  /\ WF_vars(Deliver) /\ WF_vars(ServerBoot) /\ WF_vars(Tick) /\ WF_vars(TrFlush) /\ WF_vars(TranscriptWrite)
  /\ WF_vars(ReconcileGood) /\ WF_vars(ReconcileAny)
Spec == Init /\ [][Next]_vars /\ Fairness

\* ---------------------------------------------------------------------------
\* Properties
\* an "after the turn" / "between turns" action never kills a turn in progress
NoKillMidTurn == badKill \notin {"afterTurn", "restartNow", "ctlSettings", "move"}
\* the same, only for the kill done by reconcile() for restartWhenDone (index.ts:572)
NoKillMidTurnByReconcile == badKill # "afterTurn"
\* a live agent is never killed because of a listing error or a wrong "suspended" status
NoKillLiveOnListingError == badKill \notin {"listing", "falseSuspend"}
\* a live session wrongly marked suspended is marked otherwise later
NoFalseSuspendForever == (Owned /\ Live /\ status = "suspended") ~> (~Live \/ status # "suspended")
\* the controller ends up running for good (exits, crashes and setting changes are bounded)
ControllerAlive == <>[](proc \in {"idle", "turn", "approval"})
\* the controller is not relaunched forever when nothing changes
ControllerSettles == <>[][ctlGen' = ctlGen]_vars
\* once the environment stops acting, status equals the agent's real state for good
Matches == Owned => status = ViewOf(proc)
StatusConverges == <>[]Matches
=============================================================================
