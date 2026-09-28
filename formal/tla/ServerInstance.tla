---------------------------- MODULE ServerInstance ----------------------------
(***************************************************************************)
(* Several Taskboard server processes starting against one TB_DIR.         *)
(*                                                                         *)
(* What is modelled (ground truth: the code, cited as path:line):          *)
(*  - the lock file <TB_DIR>/server.pid (server/lock.ts:9)                 *)
(*  - Mode = "new": the current acquire() of server/lock.ts:24-42:         *)
(*      openSync(FILE,'wx') (exclusive create), then a separate writeSync  *)
(*      of the pid; on EEXIST read the file (liveHolder, lock.ts:13-21),  *)
(*      and when there is no live holder unlinkSync(FILE) and try again,   *)
(*      three attempts in all, then give up (lock.ts:41).                  *)
(*  - Mode = "old": the check-then-write lock that the task description    *)
(*      gives for the earlier version: read the file, exit when it names   *)
(*      a live holder, otherwise write the file (not exclusive).           *)
(*  - Mode = "fixed": a proposed order, not in the code: listen() on the   *)
(*      port first (the kernel lets exactly one process bind it and frees  *)
(*      it when the process dies), then overwrite server.pid, then do the  *)
(*      startup work.                                                      *)
(*  - after the lock, index.ts:44-586 does the startup work (it runs       *)
(*      reconcile() at index.ts:582 and starts the controller at           *)
(*      index.ts:586) BEFORE server.listen() at index.ts:596.  A listen    *)
(*      error calls process.exit(1) (index.ts:595); the 'exit' handler of  *)
(*      lock.ts:45 then deletes server.pid if it names this process.       *)
(*  - SIGKILL / crash at any moment: no exit handler runs, server.pid is   *)
(*      left behind, the kernel frees the port.                            *)
(*  - pid reuse: a pid named by a left-behind server.pid can later belong  *)
(*      to an unrelated process ("foreign") or to another process whose    *)
(*      command line contains server/index.ts, for example a sandbox or a  *)
(*      test server ("tb").  liveHolder() treats the second as a live      *)
(*      Taskboard server (lock.ts:18-19).                                  *)
(*  - launchd KeepAlive (scripts/install-launchd.sh:20-22) restarts the    *)
(*      server process of the job whenever it is not running.  Other      *)
(*      servers are started by hand a bounded number of times.             *)
(*  - scripts/stop.mjs:7-9 (and restartProduction without launchd,         *)
(*      scripts/lib.mjs:58) send SIGTERM to the pid in server.pid without  *)
(*      checking what that process is.                                     *)
(*                                                                         *)
(* What is abstracted away: time (launchd's 10 s throttle, the 250 ms      *)
(* waits), the content of the startup work, a non-Taskboard process        *)
(* holding the port, SIGTERM arriving before the handler is installed is   *)
(* treated like a crash (Node's default SIGTERM action ends the process    *)
(* without running 'exit' handlers).                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Servers,          \* process slots, for example {s1, s2}
  Supervised,       \* the slot launchd restarts (an element of Servers)
  Mode,             \* "old" | "new" | "fixed"
  MaxCrashes,       \* bound on crashes and SIGTERMs from scripts
  MaxManualStarts,  \* bound on starts by hand of the other slots
  AllowPidReuseTB,  \* may a left-behind pid be reused by a server/index.ts process
  MaxAttempts       \* lock.ts:25 loops 3 times

VARIABLES
  pc,               \* pc[s]: where process s is (see States)
  file,             \* server.pid: NoFile, StaleF, or <<owner, "e"|"f">> (e = created, pid not yet written)
  staleOwner,       \* for file = StaleF: what the recorded pid is now: "dead", "empty" (no pid), "foreign", "tb"
  port,             \* "free" or the slot listening on port 4317
  attempts,         \* attempts[s]: finished iterations of the loop at lock.ts:25
  crashes,          \* crashes and script SIGTERMs so far
  manual,           \* manual starts so far
  signalledForeign  \* history: a script sent SIGTERM to a process that is not a Taskboard server

vars == <<pc, file, staleOwner, port, attempts, crashes, manual, signalledForeign>>

States == {"down", "oldRead", "oldWrite", "create", "write", "check", "unlink", "final",
           "flisten", "lockwrite", "startup", "listen", "up"}

\* the process believes it holds the lock
Held == IF Mode = "fixed" THEN {"lockwrite", "startup", "up"} ELSE {"startup", "listen", "up"}
\* the process runs reconcile()/startController() against the shared tmux socket (index.ts:582-586, 591)
ActsOnTmux == {"startup", "up"}
\* the 'exit' handler of lock.ts:44-53 is installed
Installed(s) == pc[s] \in {"startup", "listen", "up"}

Alive(s) == pc[s] # "down"
NoFile == <<"none", "-">>
StaleF == <<"stale", "-">>
IsOwned(f) == f[1] \in Servers

TypeOK ==
  /\ pc \in [Servers -> States]
  /\ file \in {NoFile, StaleF} \cup (Servers \X {"e", "f"})
  /\ staleOwner \in {"dead", "empty", "foreign", "tb"}
  /\ port \in {"free"} \cup Servers
  /\ attempts \in [Servers -> 0..MaxAttempts]
  /\ crashes \in 0..MaxCrashes
  /\ manual \in 0..MaxManualStarts
  /\ signalledForeign \in BOOLEAN

Init ==
  /\ pc = [s \in Servers |-> "down"]
  /\ file = NoFile
  /\ staleOwner = "dead"
  /\ port = "free"
  /\ attempts = [s \in Servers |-> 0]
  /\ crashes = 0
  /\ manual = 0
  /\ signalledForeign = FALSE

\* lock.ts:13-21 liveHolder(): the file parses as JSON, names a pid other than ours, the pid is alive,
\* and `ps -o command=` of that pid matches /server\/index\.ts/.  An empty file fails JSON.parse -> null.
LiveHolderFor(s) ==
  \/ /\ IsOwned(file) /\ file[2] = "f" /\ file[1] # s /\ Alive(file[1])
  \/ /\ file = StaleF /\ staleOwner = "tb"

\* lock.ts:45: on exit, delete server.pid only if it names this process
ReleaseFile(s) == IF IsOwned(file) /\ file[1] = s THEN file' = NoFile ELSE UNCHANGED file

Goto(s, st) == pc' = [pc EXCEPT ![s] = st]

FirstState == CASE Mode = "old" -> "oldRead"
               [] Mode = "new" -> "create"
               [] Mode = "fixed" -> "flisten"

Start(s) ==
  /\ pc[s] = "down"
  /\ Goto(s, FirstState)
  /\ attempts' = [attempts EXCEPT ![s] = 0]
  /\ UNCHANGED <<file, staleOwner, port, crashes, signalledForeign>>

LaunchdStart == Start(Supervised) /\ UNCHANGED manual
ManualStart(s) == s # Supervised /\ manual < MaxManualStarts /\ Start(s) /\ manual' = manual + 1

\* ---------- Mode "old": read, then write (not exclusive) ----------
OldRead(s) ==
  /\ pc[s] = "oldRead"
  /\ IF LiveHolderFor(s) THEN Goto(s, "down") ELSE Goto(s, "oldWrite")
  /\ UNCHANGED <<file, staleOwner, port, attempts, crashes, manual, signalledForeign>>
OldWrite(s) ==
  /\ pc[s] = "oldWrite"
  /\ file' = <<s, "f">>
  /\ Goto(s, "startup")
  /\ UNCHANGED <<staleOwner, port, attempts, crashes, manual, signalledForeign>>

\* ---------- Mode "new": lock.ts:24-42 ----------
\* lock.ts:27 openSync(FILE,'wx'): creates an empty file, or fails with EEXIST
Create(s) ==
  /\ pc[s] = "create"
  /\ IF file = NoFile THEN file' = <<s, "e">> /\ Goto(s, "write")
                      ELSE UNCHANGED file /\ Goto(s, "check")
  /\ UNCHANGED <<staleOwner, port, attempts, crashes, manual, signalledForeign>>
\* lock.ts:28 writeSync(fd, ...): writes into the inode we created.  If that inode was unlinked by another
\* process in the meantime, the write goes to the unlinked inode and the path is not changed.
Write(s) ==
  /\ pc[s] = "write"
  /\ IF file = <<s, "e">> THEN file' = <<s, "f">> ELSE UNCHANGED file
  /\ Goto(s, "startup")
  /\ UNCHANGED <<staleOwner, port, attempts, crashes, manual, signalledForeign>>
\* lock.ts:34-35 liveHolder(); a missing or empty file also gives null
Check(s) ==
  /\ pc[s] = "check"
  /\ IF LiveHolderFor(s) THEN Goto(s, "down") ELSE Goto(s, "unlink")
  /\ UNCHANGED <<file, staleOwner, port, attempts, crashes, manual, signalledForeign>>
\* lock.ts:38 unlinkSync(FILE): removes WHATEVER file is at the path now
Unlink(s) ==
  /\ pc[s] = "unlink"
  /\ file' = NoFile
  /\ attempts' = [attempts EXCEPT ![s] = attempts[s] + 1]
  /\ Goto(s, IF attempts[s] + 1 < MaxAttempts THEN "create" ELSE "final")
  /\ UNCHANGED <<staleOwner, port, crashes, manual, signalledForeign>>
\* lock.ts:41: after 3 attempts acquire() always returns non-null, and index.ts:43 exits
Final(s) ==
  /\ pc[s] = "final"
  /\ Goto(s, "down")
  /\ UNCHANGED <<file, staleOwner, port, attempts, crashes, manual, signalledForeign>>

\* ---------- after the lock, modes "old" and "new": index.ts:44-596 ----------
Startup(s) ==
  /\ pc[s] = "startup"
  /\ Goto(s, IF Mode = "fixed" THEN "up" ELSE "listen")
  /\ UNCHANGED <<file, staleOwner, port, attempts, crashes, manual, signalledForeign>>
\* index.ts:595-596: EADDRINUSE -> process.exit(1) -> lock.ts:45 exit handler
Listen(s) ==
  /\ pc[s] = "listen"
  /\ IF port = "free"
       THEN port' = s /\ Goto(s, "up") /\ UNCHANGED file
       ELSE UNCHANGED port /\ Goto(s, "down") /\ ReleaseFile(s)
  /\ UNCHANGED <<staleOwner, attempts, crashes, manual, signalledForeign>>

\* ---------- Mode "fixed" (proposal): listen first, then record the pid ----------
FListen(s) ==
  /\ pc[s] = "flisten"
  /\ IF port = "free" THEN port' = s /\ Goto(s, "lockwrite")
                      ELSE UNCHANGED port /\ Goto(s, "down")
  /\ UNCHANGED <<file, staleOwner, attempts, crashes, manual, signalledForeign>>
LockWrite(s) ==
  /\ pc[s] = "lockwrite"
  /\ file' = <<s, "f">>
  /\ Goto(s, "startup")
  /\ UNCHANGED <<staleOwner, port, attempts, crashes, manual, signalledForeign>>

\* ---------- failures and the environment ----------
\* SIGKILL, a crash in native code, the machine sleeping through a kill: no exit handler runs
CrashEffect(s) ==
  /\ Goto(s, "down")
  /\ port' = IF port = s THEN "free" ELSE port
  /\ IF IsOwned(file) /\ file[1] = s
       THEN file' = StaleF /\ staleOwner' = IF file[2] = "e" THEN "empty" ELSE "dead"
       ELSE UNCHANGED <<file, staleOwner>>
Crash(s) ==
  /\ Alive(s) /\ crashes < MaxCrashes
  /\ CrashEffect(s)
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<attempts, manual, signalledForeign>>

\* scripts/stop.mjs:7-9: read server.pid and SIGTERM that pid, whatever it is
StopScript ==
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ \/ /\ file = StaleF /\ staleOwner \in {"foreign", "tb"}
        /\ signalledForeign' = TRUE
        /\ staleOwner' = "dead"
        /\ UNCHANGED <<pc, file, port, attempts, manual>>
     \/ /\ IsOwned(file) /\ file[2] = "f"
        /\ LET o == file[1] IN
             IF Installed(o)
               THEN \* lock.ts:48 SIGTERM handler -> process.exit(0) -> exit handler deletes the file
                    /\ Goto(o, "down") /\ file' = NoFile /\ port' = IF port = o THEN "free" ELSE port
                    /\ UNCHANGED staleOwner
               ELSE CrashEffect(o)
        /\ UNCHANGED <<attempts, manual, signalledForeign>>

\* the OS gives the recorded pid to a new process
PidReuse ==
  /\ file = StaleF /\ staleOwner = "dead"
  /\ staleOwner' \in (IF AllowPidReuseTB THEN {"foreign", "tb"} ELSE {"foreign"})
  /\ UNCHANGED <<pc, file, port, attempts, crashes, manual, signalledForeign>>
\* that process ends (no fairness: a sandbox server may run for days)
ForeignExit ==
  /\ staleOwner \in {"foreign", "tb"}
  /\ staleOwner' = "dead"
  /\ UNCHANGED <<pc, file, port, attempts, crashes, manual, signalledForeign>>

Step(s) == OldRead(s) \/ OldWrite(s) \/ Create(s) \/ Write(s) \/ Check(s) \/ Unlink(s) \/ Final(s)
           \/ Startup(s) \/ Listen(s) \/ FListen(s) \/ LockWrite(s)

Next ==
  \/ LaunchdStart
  \/ \E s \in Servers : ManualStart(s) \/ Step(s) \/ Crash(s)
  \/ StopScript \/ PidReuse \/ ForeignExit

Spec == Init /\ [][Next]_vars /\ WF_vars(LaunchdStart) /\ \A s \in Servers : WF_vars(Step(s))

\* ---------- properties ----------
\* at most one process believes it holds the lock
MutualExclusion == Cardinality({s \in Servers : pc[s] \in Held}) <= 1
\* at most one process runs reconcile()/startController() on the shared tmux socket
SingleReconciler == Cardinality({s \in Servers : pc[s] \in ActsOnTmux}) <= 1
\* a process past startup is recorded in server.pid (so the next starter sees it, and stop.mjs finds it)
HolderRecorded == \A s \in Servers : pc[s] \in {"startup", "up"} => file = <<s, "f">>
\* server.pid never names a live process that does not hold the lock
FileNamesOnlyHolder == IsOwned(file) /\ file[2] = "f" /\ Alive(file[1]) => pc[file[1]] \in Held
\* scripts never SIGTERM a process that is not a Taskboard server
NoForeignSignal == ~signalledForeign
\* liveness: from some point on, a server is always up (crashes and manual starts are bounded)
EventuallyAlwaysUp == <>[](\E s \in Servers : pc[s] = "up")
=============================================================================
