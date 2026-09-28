------------------------------- MODULE Release -------------------------------
(***************************************************************************)
(* `pnpm release` switching the real Taskboard from release A (running,   *)
(* known to work) to a new release B, with launchd as the supervisor.      *)
(*                                                                         *)
(* Modelled (scripts/release.mjs:69-80, scripts/lib.mjs:53-77,             *)
(* scripts/install-launchd.sh:17-22):                                      *)
(*  - app: the symlink ~/.taskboard/app; switchTo() replaces it atomically *)
(*    (lib.mjs:72-77).                                                     *)
(*  - launchd starts whatever app points to when it (re)starts the job     *)
(*    (ProgramArguments use $APP, install-launchd.sh:17-18), and restarts  *)
(*    it whenever it stops (KeepAlive).                                    *)
(*  - the script: switchTo(B); restartProduction() = launchctl kickstart   *)
(*    -k then wait up to 30 s for /api/info from a new pid (lib.mjs:55-68);*)
(*    if that answer is not from B, switchTo(A) and restart again          *)
(*    (release.mjs:76-79).                                                 *)
(*  - the script process can stop at any point (terminal closed, Ctrl-C,   *)
(*    laptop sleep).                                                       *)
(*  - quality of B, chosen once: "good"; "badStart" (never answers);       *)
(*    "badLate" (passes the sandbox start check of release.mjs:47-58 and   *)
(*    answers within 30 s, then crashes, for example on real data or on    *)
(*    the first reconcile of real tmux sessions).                          *)
(*  - Fixed = TRUE adds a proposal, not in the code: the launchd job runs  *)
(*    a wrapper that counts starts that crash before a health mark and,   *)
(*    after 2 of them, points app back at the last release that reached   *)
(*    the health mark.                                                     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Fixed, ScriptMayDie  \* ScriptMayDie: may the release script process stop part way

VARIABLES app, srv, srvRel, quality, script, fails, lastGood
vars == <<app, srv, srvRel, quality, script, fails, lastGood>>

TypeOK ==
  /\ app \in {"A", "B"} /\ srv \in {"down", "up"} /\ srvRel \in {"A", "B"}
  /\ quality \in [{"A", "B"} -> {"good", "badStart", "badLate"}]
  /\ script \in {"idle", "switched", "restarted", "rolledBack", "restartedBack", "done", "dead"}
  /\ fails \in 0..2 /\ lastGood \in {"A", "B"}

Init ==
  /\ app = "A" /\ srv = "up" /\ srvRel = "A"
  /\ quality \in {[r \in {"A", "B"} |-> IF r = "A" THEN "good" ELSE q] : q \in {"good", "badStart", "badLate"}}
  /\ script = "idle" /\ fails = 0 /\ lastGood = "A"

\* ---------- launchd and the server ----------
\* KeepAlive: start the release app points to now
LaunchdStart ==
  /\ srv = "down"
  /\ IF quality[app] = "badStart"
       THEN UNCHANGED <<srv, srvRel>> /\ fails' = IF Fixed THEN (IF fails < 2 THEN fails + 1 ELSE 2) ELSE 0
       ELSE srv' = "up" /\ srvRel' = app /\ UNCHANGED fails
  /\ UNCHANGED <<app, quality, script, lastGood>>
\* a "badLate" release crashes some time after it answered
LateCrash ==
  /\ srv = "up" /\ quality[srvRel] = "badLate"
  /\ srv' = "down"
  /\ fails' = IF Fixed THEN (IF fails < 2 THEN fails + 1 ELSE 2) ELSE 0
  /\ UNCHANGED <<app, srvRel, quality, script, lastGood>>
\* Fixed only: a server that stayed up past the health window marks its release as good
Healthy ==
  /\ Fixed /\ srv = "up" /\ quality[srvRel] = "good" /\ (lastGood # srvRel \/ fails # 0)
  /\ lastGood' = srvRel /\ fails' = 0
  /\ UNCHANGED <<app, srv, srvRel, quality, script>>
\* Fixed only: the wrapper goes back to the last healthy release after 2 failed starts
WrapperRollback ==
  /\ Fixed /\ fails = 2 /\ app # lastGood
  /\ app' = lastGood /\ fails' = 0
  /\ UNCHANGED <<srv, srvRel, quality, script, lastGood>>

\* ---------- the release script ----------
Switch == script = "idle" /\ app' = "B" /\ script' = "switched" /\ UNCHANGED <<srv, srvRel, quality, fails, lastGood>>
\* launchctl kickstart -k: the running server is stopped; launchd starts it again from app
Kick(from, to) == script = from /\ srv' = "down" /\ script' = to /\ UNCHANGED <<app, srvRel, quality, fails, lastGood>>
Restart == Kick("switched", "restarted")
WaitOK == script = "restarted" /\ srv = "up" /\ srvRel = "B" /\ script' = "done" /\ UNCHANGED <<app, srv, srvRel, quality, fails, lastGood>>
\* 30 s without an answer from the new release: switchTo(previous) (release.mjs:77-78)
WaitTimeout == script = "restarted" /\ ~(srv = "up" /\ srvRel = "B") /\ app' = "A" /\ script' = "rolledBack" /\ UNCHANGED <<srv, srvRel, quality, fails, lastGood>>
RestartBack == Kick("rolledBack", "restartedBack")
WaitBack == script = "restartedBack" /\ script' = "done" /\ UNCHANGED <<app, srv, srvRel, quality, fails, lastGood>>
ScriptDies == ScriptMayDie /\ script \notin {"idle", "done", "dead"} /\ script' = "dead" /\ UNCHANGED <<app, srv, srvRel, quality, fails, lastGood>>

ScriptStep == Switch \/ Restart \/ WaitOK \/ WaitTimeout \/ RestartBack \/ WaitBack

Next == LaunchdStart \/ LateCrash \/ Healthy \/ WrapperRollback \/ ScriptStep \/ ScriptDies

Spec == Init /\ [][Next]_vars /\ WF_vars(LaunchdStart) /\ WF_vars(LateCrash) /\ WF_vars(Healthy)
        /\ WF_vars(WrapperRollback) /\ WF_vars(ScriptStep)

\* from some point on the real Taskboard is always up
EventuallyAlwaysUp == <>[](srv = "up")
=============================================================================
