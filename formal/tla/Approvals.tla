------------------------------ MODULE Approvals ------------------------------
(***************************************************************************)
(* Controller actions that wait for the user's approval.                   *)
(*                                                                         *)
(* Modelled (Fixed = FALSE is the code as it is):                          *)
(*  - guarded() (index.ts:91-96): a request with header x-tb-actor =       *)
(*    "controller" is stored with approvals.request() (approvals.ts:15-18) *)
(*    in an in-memory Map and answered 202 with the approval id.  Any     *)
(*    other x-tb-actor value runs the action at once.                      *)
(*  - tb (bin/tb:19-27) polls GET /api/approvals/<id> every 2 s with no   *)
(*    time limit.  It ends with "approved" (exit 0) or anything else       *)
(*    (exit 3).  A 404 has an empty body, so `.json()` throws; a refused   *)
(*    connection throws too; either way tb stops with an error.  The      *)
(*    controller's Bash tool call can also time out and end tb.            *)
(*  - decide() (approvals.ts:19-24): if the state is not 'pending' it      *)
(*    returns; deny sets 'denied'; approve AWAITS the runner and only then *)
(*    sets 'approved' (or 'failed').  While the runner runs the state is   *)
(*    still 'pending', the dashboard still shows the card with its        *)
(*    buttons (web/src/App.tsx:171-175), and a second POST .../approve or  *)
(*    .../deny is accepted.                                                *)
(*  - the server can crash or be restarted at any point; the Map is lost.  *)
(*  - the controller agent may try the same action again after an error.   *)
(*                                                                         *)
(* One logical action of the controller; its first request gets id 1, a  *)
(* retry gets id 2.  The runner is split in three steps: started, side     *)
(* effect done (a task started, keys typed), state written.                *)
(*                                                                         *)
(* Fixed = TRUE, proposals (not in the code):                              *)
(*  - decide() sets a 'running' state before awaiting the runner, so a    *)
(*    second click is ignored;                                             *)
(*  - approvals are written to disk; after a restart a pending one is     *)
(*    pending again and one that was running is reported as 'unknown'     *)
(*    (its side effect may or may not have happened);                      *)
(*  - tb returns the approval id at once and the controller asks for the   *)
(*    result later, retrying on connection errors: no tb time limit, no    *)
(*    crash on 404.                                                        *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Fixed, ControllerMayBypass, MaxClicks, MaxCrashes

Ids == {1, 2}
VARIABLES
  srvUp,
  appr,        \* appr[i]: "absent", "pending", "running" (Fixed only), "approved", "denied", "failed", "unknown"
  pre,         \* pre[i]: runner calls started, side effect not yet done
  post,        \* post[i]: runner calls whose side effect is done, state not yet written
  execs,       \* execs[i]: how many times the side effect of request i happened
  client,      \* tb: "idle", "waiting", "ok", "denied", "failed", "error", "unknown"
  cid,         \* the id tb waits for (0 = none yet)
  nextId,      \* the id the next request gets
  clicks,      \* Approve/Deny POSTs so far
  crashes,
  deniedEver,  \* history: appr[i] was "denied" at some point
  errEver,     \* history: tb reported an error or a non-approval for request i
  bypassed     \* history: an action ran without an approval

vars == <<srvUp, appr, pre, post, execs, client, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>

TypeOK ==
  /\ srvUp \in BOOLEAN
  /\ appr \in [Ids -> {"absent", "pending", "running", "approved", "denied", "failed", "unknown"}]
  /\ pre \in [Ids -> 0..MaxClicks] /\ post \in [Ids -> 0..MaxClicks] /\ execs \in [Ids -> 0..MaxClicks + 1]
  /\ client \in {"idle", "waiting", "ok", "denied", "failed", "error", "unknown"}
  /\ cid \in 0..2 /\ nextId \in 1..3

Init ==
  /\ srvUp = TRUE /\ appr = [i \in Ids |-> "absent"] /\ pre = [i \in Ids |-> 0] /\ post = [i \in Ids |-> 0]
  /\ execs = [i \in Ids |-> 0] /\ client = "idle" /\ cid = 0 /\ nextId = 1
  /\ clicks = 0 /\ crashes = 0 /\ deniedEver = [i \in Ids |-> FALSE] /\ errEver = [i \in Ids |-> FALSE]
  /\ bypassed = FALSE

\* tb new/send/park/archive from the controller (bin/tb:15 sends x-tb-actor = $TASK_ID = "controller")
Request ==
  /\ client = "idle" /\ nextId <= 2
  /\ IF srvUp
       THEN appr' = [appr EXCEPT ![nextId] = "pending"] /\ client' = "waiting" /\ UNCHANGED errEver
       ELSE UNCHANGED appr /\ client' = "error" /\ errEver' = [errEver EXCEPT ![nextId] = TRUE]  \* fetch fails
  /\ cid' = nextId /\ nextId' = nextId + 1
  /\ UNCHANGED <<srvUp, pre, post, execs, clicks, crashes, deniedEver, bypassed>>

\* the controller sends the request without x-tb-actor: controller (for example TASK_ID=x tb send ..., or curl
\* with the token from ~/.taskboard/token); guarded() runs it at once (index.ts:92)
Bypass ==
  /\ ControllerMayBypass /\ srvUp /\ client = "idle" /\ nextId <= 2
  /\ execs' = [execs EXCEPT ![nextId] = @ + 1] /\ bypassed' = TRUE
  /\ client' = "ok" /\ cid' = nextId /\ nextId' = nextId + 1
  /\ UNCHANGED <<srvUp, appr, pre, post, clicks, crashes, deniedEver, errEver>>

\* the user clicks Approve (POST /api/approvals/:id/approve, index.ts:99-103 -> decide)
Approve(i) ==
  /\ srvUp /\ clicks < MaxClicks /\ appr[i] = "pending"
  /\ clicks' = clicks + 1
  /\ pre' = [pre EXCEPT ![i] = @ + 1]
  /\ appr' = IF Fixed THEN [appr EXCEPT ![i] = "running"] ELSE appr
  /\ UNCHANGED <<srvUp, post, execs, client, cid, nextId, crashes, deniedEver, errEver, bypassed>>
\* the user clicks Deny
Deny(i) ==
  /\ srvUp /\ clicks < MaxClicks /\ appr[i] = "pending"
  /\ clicks' = clicks + 1
  /\ appr' = [appr EXCEPT ![i] = "denied"] /\ deniedEver' = [deniedEver EXCEPT ![i] = TRUE]
  /\ UNCHANGED <<srvUp, pre, post, execs, client, cid, nextId, crashes, errEver, bypassed>>

\* the runner does its side effect (startTask, tmux send-keys, store.update, killSession)
Effect(i) ==
  /\ srvUp /\ pre[i] > 0
  /\ pre' = [pre EXCEPT ![i] = @ - 1] /\ post' = [post EXCEPT ![i] = @ + 1] /\ execs' = [execs EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<srvUp, appr, client, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>
\* the runner throws before any side effect (approvals.ts:22 catch -> 'failed')
FailEarly(i) ==
  /\ srvUp /\ pre[i] > 0
  /\ pre' = [pre EXCEPT ![i] = @ - 1] /\ appr' = [appr EXCEPT ![i] = "failed"]
  /\ UNCHANGED <<srvUp, post, execs, client, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>
\* the runner returns; x.state = 'approved' overwrites whatever the state is now (approvals.ts:22)
Complete(i) ==
  /\ srvUp /\ post[i] > 0
  /\ post' = [post EXCEPT ![i] = @ - 1] /\ appr' = [appr EXCEPT ![i] = "approved"]
  /\ UNCHANGED <<srvUp, pre, execs, client, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>

\* tb polls (bin/tb:21-26)
Poll ==
  /\ client = "waiting"
  /\ IF ~srvUp
       THEN IF Fixed THEN UNCHANGED <<client, errEver>>                  \* Fixed: try again later
            ELSE client' = "error" /\ errEver' = [errEver EXCEPT ![cid] = TRUE]   \* fetch throws
       ELSE CASE appr[cid] \in {"pending", "running"} -> UNCHANGED <<client, errEver>>
              [] appr[cid] = "approved" -> client' = "ok" /\ UNCHANGED errEver
              [] appr[cid] = "denied"   -> client' = "denied" /\ errEver' = [errEver EXCEPT ![cid] = TRUE]
              [] appr[cid] = "failed"   -> client' = "failed" /\ errEver' = [errEver EXCEPT ![cid] = TRUE]
              [] appr[cid] = "unknown"  -> client' = "unknown" /\ UNCHANGED errEver
              [] appr[cid] = "absent"   -> client' = "error" /\ errEver' = [errEver EXCEPT ![cid] = TRUE]  \* 404, .json() throws
  /\ UNCHANGED <<srvUp, appr, pre, post, execs, cid, nextId, clicks, crashes, deniedEver, bypassed>>

\* the controller's Bash tool call times out and ends tb (Fixed: tb does not wait, so this does not happen)
ClientTimeout ==
  /\ ~Fixed /\ client = "waiting"
  /\ client' = "error" /\ errEver' = [errEver EXCEPT ![cid] = TRUE]
  /\ UNCHANGED <<srvUp, appr, pre, post, execs, cid, nextId, clicks, crashes, deniedEver, bypassed>>

\* the controller tries again after an error or a failure
Retry ==
  /\ client \in {"error", "failed"} /\ nextId <= 2
  /\ client' = "idle"
  /\ UNCHANGED <<srvUp, appr, pre, post, execs, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>

\* the server stops (crash, release, launchd restart).  Runners in progress stop with it.
Crash ==
  /\ srvUp /\ crashes < MaxCrashes
  /\ srvUp' = FALSE /\ crashes' = crashes + 1
  /\ pre' = [i \in Ids |-> 0] /\ post' = [i \in Ids |-> 0]
  /\ appr' = IF Fixed
               THEN [i \in Ids |-> IF appr[i] = "running" THEN "unknown" ELSE appr[i]]
               ELSE [i \in Ids |-> "absent"]                        \* approvals.ts:9 Map is in memory
  /\ UNCHANGED <<execs, client, cid, nextId, clicks, deniedEver, errEver, bypassed>>
Boot ==
  /\ ~srvUp /\ srvUp' = TRUE
  /\ UNCHANGED <<appr, pre, post, execs, client, cid, nextId, clicks, crashes, deniedEver, errEver, bypassed>>

Next ==
  \/ Request \/ Bypass \/ Poll \/ ClientTimeout \/ Retry \/ Crash \/ Boot
  \/ \E i \in Ids : Approve(i) \/ Deny(i) \/ Effect(i) \/ FailEarly(i) \/ Complete(i)

Spec == Init /\ [][Next]_vars /\ WF_vars(Boot) /\ WF_vars(Poll)
        /\ \A i \in Ids : WF_vars(Effect(i)) /\ WF_vars(Complete(i))

\* ---------- properties ----------
\* nothing runs without an approval
NoExecWithoutApproval == ~bypassed
\* one approval runs its action at most once
AtMostOncePerApproval == \A i \in Ids : execs[i] <= 1
\* the controller's one intended action runs at most once, even across a retry
AtMostOncePerIntent == execs[1] + execs[2] <= 1
\* an approval that was denied never runs
DeniedNeverRuns == \A i \in Ids : deniedEver[i] => execs[i] = 0
\* when tb reports an error, a denial or a failure, the action did not run and will not run
ErrorMeansNotRun == \A i \in Ids : errEver[i] => execs[i] = 0
\* when tb reports success, the action ran
OkMeansRun == client = "ok" => execs[cid] >= 1
\* tb does not wait forever once the user has decided
AnswerArrives == \A i \in Ids : (client = "waiting" /\ cid = i /\ appr[i] \in {"approved", "denied", "failed", "unknown"}) ~> client # "waiting"
\* state constraint for Approvals_singleClick.cfg: at most one runner per approval, to show the other paths
OneRunPerApproval == \A i \in Ids : pre[i] + post[i] <= 1 /\ execs[i] <= 1
=============================================================================
