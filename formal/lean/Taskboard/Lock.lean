/-
The single-server lock on ~/.taskboard/server.pid (server/lock.ts), as a transition system over any number of
processes. Process ids are natural numbers. A run is a list of steps; each step is one process doing one system
call, so interleavings between processes are arbitrary.

"p believes it holds the lock" means `pc p = holding`: `acquire()` returned null (lock.ts:30), so index.ts:42-43
carries on as the server.

Three designs are modelled:
* OLD: read server.pid; if its holder is alive, exit; otherwise write the own pid. Reading and writing are two steps.
* NEW (the current lock.ts:24-41): exclusive create (`openSync(FILE, 'wx')`), then write the pid into the new file.
  If the create fails because the file exists, read it (`liveHolder`, lock.ts:13-21); if there is no live holder,
  unlink the file and retry, at most 3 attempts; after that, give up.
* KERNEL: a lock the operating system releases when its owner dies (flock(2), or binding the TCP port). This is a
  proposed design, not the current code.
-/
import Taskboard.Basic

namespace Taskboard.Lock

abbrev Pid := Nat

/-- Function update. -/
def upd {α : Type} (f : Pid → α) (p : Pid) (v : α) : Pid → α := fun q => if q = p then v else f q

/-! ## NEW design (current lock.ts) -/

/-- The file server.pid. `creator` stands for the file's identity (its inode): a process writes through the
descriptor it got from its own create, so its write lands in the file it created even if that file has since
been unlinked and replaced. `content = none` is the state between `openSync` (lock.ts:27) and `writeSync`
(lock.ts:28): the file exists and is empty. -/
structure File where
  creator : Pid
  content : Option Pid
  deriving DecidableEq, Repr

/-- Where a process is in `acquire()`. `attempt` counts the loop at lock.ts:25. -/
inductive PC where
  | start (attempt : Nat)       -- about to call openSync(FILE, 'wx')
  | created                     -- the exclusive create succeeded; the pid is not written yet
  | sawExists (attempt : Nat)   -- the create failed with EEXIST; about to call liveHolder()
  | stale (attempt : Nat)       -- liveHolder() returned null; about to unlink the file
  | holding                     -- acquire() returned null: the process runs as the server
  | exited                      -- acquire() returned a holder: index.ts:43 exits
  deriving DecidableEq, Repr

structure S where
  file : Option File
  pc : Pid → PC
  alive : Pid → Bool

inductive Step where
  | create (p : Pid)   -- lock.ts:27
  | write (p : Pid)    -- lock.ts:28-31
  | check (p : Pid)    -- lock.ts:33-35
  | unlink (p : Pid)   -- lock.ts:38 (and the retry of the loop, or giving up at lock.ts:41)
  | crash (p : Pid)    -- the process dies; the file stays
  | exit (p : Pid)     -- clean exit of the server: the release handler at lock.ts:45
  deriving DecidableEq, Repr

/-- `liveHolder()` (lock.ts:13-21) as seen by process `p`. A missing file or an empty file makes
`readFileSync`/`JSON.parse` throw, and the catch returns null. -/
def liveHolder (s : S) (p : Pid) : Option Pid :=
  match s.file with
  | none => none
  | some f => match f.content with
    | none => none
    | some q => if q = p then none else if s.alive q then some q else none

def stepNew (s : S) : Step → S
  | .create p =>
    if s.alive p then
      match s.pc p with
      | .start k =>
        match s.file with
        | none => { s with file := some ⟨p, none⟩, pc := upd s.pc p .created }
        | some _ => { s with pc := upd s.pc p (.sawExists k) }
      | _ => s
    else s
  | .write p =>
    if s.alive p then
      match s.pc p with
      | .created =>
        { s with
          file := (match s.file with
            | some f => if f.creator = p then some ⟨p, some p⟩ else some f
            | none => none),
          pc := upd s.pc p .holding }
      | _ => s
    else s
  | .check p =>
    if s.alive p then
      match s.pc p with
      | .sawExists k =>
        match liveHolder s p with
        | some _ => { s with pc := upd s.pc p .exited }
        | none => { s with pc := upd s.pc p (.stale k) }
      | _ => s
    else s
  | .unlink p =>
    if s.alive p then
      match s.pc p with
      | .stale k => { s with file := none, pc := upd s.pc p (if k + 1 < 3 then .start (k + 1) else .exited) }
      | _ => s
    else s
  | .crash p => { s with alive := upd s.alive p false }
  | .exit p =>
    if s.alive p ∧ s.pc p = .holding then
      { file := (match s.file with
          | some f => if f.content = some p then none else some f
          | none => none),
        pc := upd s.pc p .exited,
        alive := upd s.alive p false }
    else s

def runNew (s : S) (steps : List Step) : S := steps.foldl stepNew s

/-- Every process alive, about to start, no file. -/
def init : S := { file := none, pc := fun _ => .start 0, alive := fun _ => true }

/-- Processes `p` and `q` are both alive and both believe they hold the lock. -/
def bothHold (s : S) (p q : Pid) : Bool :=
  s.alive p && s.alive q && s.pc p == .holding && s.pc q == .holding

/-- **NEW is not safe (1): stale-file removal races.** Server 9 takes the lock and crashes, leaving its file.
Servers 0 and 1 start together; both find the file, both see that 9 is dead. Server 0 unlinks the file,
creates its own and holds the lock. Server 1 then runs its unlink (lock.ts:38), which removes server 0's file, and
creates its own. Both are alive and hold the lock. The comment at lock.ts:36-37 ("the next attempt sees it as a
live holder") covers a winner that creates after the loser's unlink, not one that creates before it. -/
def traceStale : List Step :=
  [.create 9, .write 9, .crash 9,
   .create 0, .create 1, .check 0, .check 1,
   .unlink 0, .create 0, .write 0,
   .unlink 1, .create 1, .write 1]

theorem new_two_holders_after_crash : bothHold (runNew init traceStale) 0 1 = true := by decide

/-- **NEW is not safe (2): the empty-file window.** No crash is needed. Server 0 creates the file; before it writes
its pid (lock.ts:27 and :28 are separate system calls), server 1's create fails, it reads the empty file,
`JSON.parse('')` throws, `liveHolder()` returns null, and server 1 treats the file as stale: it unlinks it, creates
its own and holds the lock. Server 0's write goes to its unlinked file and it also holds the lock. -/
def traceEmpty : List Step :=
  [.create 0, .create 1, .check 1, .unlink 1, .create 1, .write 1, .write 0]

theorem new_two_holders_empty_file : bothHold (runNew init traceEmpty) 0 1 = true := by decide

/-! ### What is true of NEW: the exclusive create alone is safe -/

def isUnlink : Step → Bool
  | .unlink _ => true
  | _ => false

/-- Invariant: a process that has created the file or holds the lock is the creator of the current file. -/
def Inv (s : S) : Prop :=
  ∀ p, (s.pc p = .holding ∨ s.pc p = .created) → s.file.map File.creator = some p

theorem inv_init : Inv init := by
  intro p h; simp [init] at h

theorem upd_same {α : Type} (f : Pid → α) (p : Pid) (v : α) : upd f p v p = v := by simp [upd]
theorem upd_other {α : Type} (f : Pid → α) (p q : Pid) (v : α) (h : q ≠ p) : upd f p v q = f q := by simp [upd, h]

theorem inv_step (s : S) (st : Step) (hst : isUnlink st = false) (h : Inv s) : Inv (stepNew s st) := by
  cases st with
  | create p =>
    simp only [stepNew]
    split
    · split
      · rename_i k hk
        split
        · rename_i hf
          intro q hq
          by_cases e : q = p
          · subst e; simp [hf]
          · simp [upd_other _ _ _ _ e] at hq
            have := h q hq; rw [hf] at this; simp at this
        · intro q hq
          by_cases e : q = p
          · subst e; simp [upd_same] at hq
          · simp [upd_other _ _ _ _ e] at hq; exact h q hq
      · exact h
    · exact h
  | write p =>
    simp only [stepNew]
    split
    · split
      · rename_i hc
        have hp := h p (Or.inr hc)
        intro q hq
        have hmap : (match s.file with
            | some f => if f.creator = p then some (⟨p, some p⟩ : File) else some f
            | none => none).map File.creator = s.file.map File.creator := by
          cases hf : s.file with
          | none => rfl
          | some f => by_cases e : f.creator = p <;> simp [e]
        simp only [hmap]
        by_cases e : q = p
        · subst e; exact hp
        · simp [upd_other _ _ _ _ e] at hq; exact h q hq
      · exact h
    · exact h
  | check p =>
    simp only [stepNew]
    split
    · split
      · rename_i k hk
        split
        · intro q hq
          by_cases e : q = p
          · subst e; simp [upd_same] at hq
          · simp [upd_other _ _ _ _ e] at hq; exact h q hq
        · intro q hq
          by_cases e : q = p
          · subst e; simp [upd_same] at hq
          · simp [upd_other _ _ _ _ e] at hq; exact h q hq
      · exact h
    · exact h
  | unlink p => simp [isUnlink] at hst
  | crash p => exact h
  | exit p =>
    simp only [stepNew]
    split
    · rename_i hc
      have hp := h p (Or.inl hc.2)
      intro q hq
      by_cases e : q = p
      · subst e; simp [upd_same] at hq
      · simp [upd_other _ _ _ _ e] at hq
        have hq' := h q hq
        rw [hp] at hq'; simp at hq'; exact absurd hq'.symm e
    · exact h

theorem inv_run (steps : List Step) (hs : ∀ st ∈ steps, isUnlink st = false) :
    ∀ s, Inv s → Inv (runNew s steps) := by
  induction steps with
  | nil => intro s h; exact h
  | cons st rest ih =>
    intro s h
    simp only [runNew, List.foldl_cons]
    exact ih (fun x hx => hs x (by simp [hx])) _ (inv_step s st (hs st (by simp)) h)

/-- **What is safe in NEW.** In every run in which no process takes the stale-file path (no unlink step), at most
one process ever believes it holds the lock, alive or not. The exclusive create is sound; the two failures above
both go through the unlink at lock.ts:38. The price: without the unlink, a crashed server's file blocks every later
server (that is why the unlink exists). -/
theorem new_safe_without_unlink (steps : List Step) (hs : ∀ st ∈ steps, isUnlink st = false) (p q : Pid)
    (hp : (runNew init steps).pc p = .holding) (hq : (runNew init steps).pc q = .holding) : p = q := by
  have hi := inv_run steps hs init inv_init
  have a := hi p (Or.inl hp)
  have b := hi q (Or.inl hq)
  rw [a] at b; simp at b; exact b

/-! ## OLD design: check, then write -/

inductive OPC where
  | start | decided | holding | exited
  deriving DecidableEq, Repr

structure OS where
  file : Option Pid
  pc : Pid → OPC
  alive : Pid → Bool

inductive OStep where
  | read (p : Pid)    -- read server.pid; exit if its holder is alive
  | write (p : Pid)   -- write the own pid
  | crash (p : Pid)
  deriving DecidableEq, Repr

def stepOld (s : OS) : OStep → OS
  | .read p =>
    if s.alive p ∧ s.pc p = .start then
      match s.file with
      | some q => if q ≠ p ∧ s.alive q then { s with pc := upd s.pc p .exited } else { s with pc := upd s.pc p .decided }
      | none => { s with pc := upd s.pc p .decided }
    else s
  | .write p =>
    if s.alive p ∧ s.pc p = .decided then { s with file := some p, pc := upd s.pc p .holding } else s
  | .crash p => { s with alive := upd s.alive p false }

def runOld (s : OS) (steps : List OStep) : OS := steps.foldl stepOld s
def oinit : OS := { file := none, pc := fun _ => .start, alive := fun _ => true }

/-- **OLD is not safe.** Both servers read before either writes. -/
theorem old_two_holders :
    let s := runOld oinit [.read 0, .read 1, .write 0, .write 1]
    (s.alive 0 && s.alive 1 && s.pc 0 == .holding && s.pc 1 == .holding) = true := by decide

/-! ## KERNEL design: a lock the operating system releases when the owner dies -/

inductive KPC where
  | start | holding | exited
  deriving DecidableEq, Repr

structure KS where
  owner : Option Pid
  pc : Pid → KPC
  alive : Pid → Bool

inductive KStep where
  | take (p : Pid)    -- flock(fd, LOCK_EX | LOCK_NB), or listen() on the port
  | crash (p : Pid)   -- the process dies (any way); the kernel drops its lock
  deriving DecidableEq, Repr

def stepK (s : KS) : KStep → KS
  | .take p =>
    if s.alive p ∧ s.pc p = .start then
      match s.owner with
      | none => { s with owner := some p, pc := upd s.pc p .holding }
      | some _ => { s with pc := upd s.pc p .exited }
    else s
  | .crash p =>
    { s with alive := upd s.alive p false, owner := if s.owner = some p then none else s.owner }

def runK (s : KS) (steps : List KStep) : KS := steps.foldl stepK s
def kinit : KS := { owner := none, pc := fun _ => .start, alive := fun _ => true }

def KInv (s : KS) : Prop := ∀ p, s.alive p = true → s.pc p = .holding → s.owner = some p

theorem kinv_step (s : KS) (st : KStep) (h : KInv s) : KInv (stepK s st) := by
  cases st with
  | take p =>
    simp only [stepK]
    split
    · split
      · rename_i ho
        intro q ha hq
        by_cases e : q = p
        · subst e; rfl
        · simp [upd_other _ _ _ _ e] at hq
          have := h q ha hq; rw [ho] at this; simp at this
      · intro q ha hq
        by_cases e : q = p
        · subst e; simp [upd_same] at hq
        · simp [upd_other _ _ _ _ e] at hq; exact h q ha hq
    · exact h
  | crash p =>
    intro q ha hq
    simp only [stepK] at ha hq ⊢
    by_cases e : q = p
    · subst e; simp [upd_same] at ha
    · simp [upd_other _ _ _ _ e] at ha
      have := h q ha hq
      rw [this]; simpa using e

theorem kinv_run (steps : List KStep) : ∀ s, KInv s → KInv (runK s steps) := by
  induction steps with
  | nil => intro s h; exact h
  | cons st rest ih => intro s h; exact ih _ (kinv_step s st h)

/-- **KERNEL is safe for any number of processes and any interleaving, crashes included:** at most one live
process believes it holds the lock. A crash releases the lock, so a later server can start (no stale file). -/
theorem kernel_lock_safe (steps : List KStep) (p q : Pid)
    (hap : (runK kinit steps).alive p = true) (haq : (runK kinit steps).alive q = true)
    (hp : (runK kinit steps).pc p = .holding) (hq : (runK kinit steps).pc q = .holding) : p = q := by
  have hi := kinv_run steps kinit (by intro p _ h; simp [kinit] at h)
  have a := hi p hap hp
  have b := hi q haq hq
  rw [a] at b; simp at b; exact b

/-- After the owner crashes, another process can take the kernel lock. -/
theorem kernel_lock_recovers :
    let s := runK kinit [.take 0, .crash 0, .take 1]
    (s.alive 1 && s.pc 1 == .holding) = true := by decide

end Taskboard.Lock
