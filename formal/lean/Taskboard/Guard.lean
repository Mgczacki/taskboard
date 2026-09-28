/-
The PreToolUse guard (server/hooks/guard.mjs). It reads the Bash command an agent is about to run and denies it
when it looks like it would stop the real Taskboard server.

What is modelled:
* `parts`: guard.mjs:23, `cmd.split(/;|&&|\|\||\||\n/)`. At each position the alternatives are tried in order,
  so "||" is one separator, not two "|".
* `r1`: guard.mjs:26, exactly (for ASCII text): a word `pkill` or `killall`, and in the same part one of
  `server/index`, `taskboard` (substrings, any case) or the words `tsx`, `node`, `npx` (any case). A "word" match
  is JavaScript `\b...\b`: the characters before and after are not letters, digits or "_".
* The other rules (guard.mjs:28, :30, :32, :36, :38, :41) are modelled by OVER-approximations: each model rule
  fires whenever the real regular expression fires (and sometimes more often). Dropping `\b` and the `.*` ordering
  constraints only makes a rule fire more.

Consequences for the theorems:
* "the model denies" is only claimed through `r1`, which is exact, so it holds for the real guard.
* "the model allows" holds for the real guard too, because every rule of the model fires at least as often as the
  real one.
* `pid` is the text of the running server's pid, read by guard.mjs:19 from server.pid. The "allowed" theorems hold
  for every pid made of digits.
-/
import Taskboard.Basic

namespace Taskboard.Guard
open Taskboard

/-- Length of the separator starting here (0 when none), trying the alternatives in the regex's order. -/
def sepLen : Str → Nat
  | ';' :: _ => 1
  | '&' :: '&' :: _ => 2
  | '|' :: '|' :: _ => 2
  | '|' :: _ => 1
  | '\n' :: _ => 1
  | _ => 0

def partsAux : Str → Str → Nat → List Str
  | [], acc, _ => [acc.reverse]
  | _ :: cs, acc, k + 1 => partsAux cs acc k
  | c :: cs, acc, 0 =>
    if sepLen (c :: cs) = 0 then partsAux cs (c :: acc) 0
    else acc.reverse :: partsAux cs [] (sepLen (c :: cs) - 1)

/-- guard.mjs:23 -/
def parts (cmd : Str) : List Str := partsAux cmd [] 0

def isWordChar (c : Char) : Bool := c.isAlphanum || c == '_'

def notWord : Option Char → Bool
  | none => true
  | some c => !isWordChar c

/-- JavaScript `/\bw\b/.test(s)` for a word `w` made of word characters. `prev` is the character before `s`. -/
def hasWordAux (w : Str) : Option Char → Str → Bool
  | _, [] => false
  | prev, c :: cs =>
    (notWord prev && w.isPrefixOf (c :: cs) && notWord ((c :: cs).drop w.length).head?) || hasWordAux w (some c) cs

def hasWord (w s : Str) : Bool := hasWordAux w none s

def lower (s : Str) : Str := s.map Char.toLower

/-- guard.mjs:26, exact for ASCII. -/
def r1 (p : Str) : Bool :=
  (hasWord "pkill".toList p || hasWord "killall".toList p) &&
  (hasInfix "server/index".toList (lower p) || hasInfix "taskboard".toList (lower p) ||
   hasWord "tsx".toList (lower p) || hasWord "node".toList (lower p) || hasWord "npx".toList (lower p))

/-- Over-approximation of guard.mjs:28 (`\bkill\b` and the pid not next to other digits). -/
def r2 (pid p : Str) : Bool := !pid.isEmpty && hasInfix "kill".toList p && hasInfix pid p

/-- Over-approximation of guard.mjs:30 (`tmux ... -L taskboard ... kill-server|kill-session`). -/
def r3 (p : Str) : Bool := hasInfix "tmux".toList p && hasInfix "kill-".toList p

/-- Over-approximation of guard.mjs:32 (launchctl bootout/unload/remove/kill ... taskboard). -/
def r4 (p : Str) : Bool := hasInfix "launchctl".toList p && hasInfix "taskboard".toList (lower p)

/-- Over-approximation of the whole-command rules guard.mjs:36 (release/rollback), :38 (rm/mv/rsync of
~/.taskboard) and :41 (kill or fuser -k with the port 4317). -/
def wholeRules (cmd : Str) : Bool :=
  hasInfix "release".toList cmd || hasInfix "rollback".toList cmd ||
  ((hasInfix "rm".toList cmd || hasInfix "mv".toList cmd || hasInfix "rsync".toList cmd) &&
    hasInfix ".taskboard".toList cmd) ||
  ((hasInfix "kill".toList cmd || hasInfix "fuser".toList cmd) && hasInfix "4317".toList cmd)

/-- The model of the guard's decision: true = deny (guard.mjs:42-47). -/
def deny (pid cmd : Str) : Bool :=
  (parts cmd).any (fun p => r1 p || r2 pid p || r3 p || r4 p) || wholeRules cmd

/-- The same without the pid rule. -/
def denyNoPid (cmd : Str) : Bool :=
  (parts cmd).any (fun p => r1 p || r3 p || r4 p) || wholeRules cmd

/-- A pid as the guard reads it: a non-empty string of digits. -/
def PidText (pid : Str) : Prop := pid ≠ [] ∧ ∀ c ∈ pid, isDigit c = true

theorem head_mem_of_hasInfix (a0 : Char) (as : Str) : ∀ s : Str, hasInfix (a0 :: as) s = true → a0 ∈ s := by
  intro s
  induction s with
  | nil => intro h; simp [hasInfix] at h
  | cons c cs ih =>
    intro h
    simp only [hasInfix, Bool.or_eq_true] at h
    rcases h with h | h
    · simp [List.isPrefixOf] at h; simp [h.1]
    · exact List.mem_cons_of_mem _ (ih h)

/-- For a command whose parts contain no digit, the pid rule never fires, whatever the pid is. -/
theorem deny_eq_noPid (pid cmd : Str) (hp : PidText pid)
    (hd : ∀ p ∈ parts cmd, ∀ c ∈ p, isDigit c = false) : deny pid cmd = denyNoPid cmd := by
  obtain ⟨hne, hdig⟩ := hp
  obtain ⟨a0, as, rfl⟩ : ∃ a0 as, pid = a0 :: as := by
    cases pid with
    | nil => exact absurd rfl hne
    | cons a0 as => exact ⟨a0, as, rfl⟩
  have hr2 : ∀ p ∈ parts cmd, r2 (a0 :: as) p = false := by
    intro p hpm
    cases h : hasInfix (a0 :: as) p
    · simp [r2, h]
    · have := hd p hpm a0 (head_mem_of_hasInfix a0 as p h)
      rw [hdig a0 (by simp)] at this; exact absurd this (by simp)
  have key : ∀ l : List Str, (∀ p ∈ l, r2 (a0 :: as) p = false) →
      l.any (fun p => r1 p || r2 (a0 :: as) p || r3 p || r4 p) = l.any (fun p => r1 p || r3 p || r4 p) := by
    intro l
    induction l with
    | nil => intro _; rfl
    | cons x xs ih =>
      intro h
      simp only [List.any_cons]
      rw [h x (by simp), ih (fun p hp => h p (by simp [hp]))]
      simp
  unfold deny denyNoPid
  rw [key _ hr2]

/-! ## What the guard denies -/

/-- **Denied (general).** Any command with a part that contains the word pkill or killall together with one of
the listed names is denied, for every pid. -/
theorem r1_denies (pid cmd p : Str) (hp : p ∈ parts cmd) (h : r1 p = true) : deny pid cmd = true := by
  unfold deny
  have : (parts cmd).any (fun p => r1 p || r2 pid p || r3 p || r4 p) = true :=
    List.any_eq_true.mpr ⟨p, hp, by simp [h]⟩
  simp [this]

/-- The command from the incident that the guard was written for (guard.mjs:4) is denied. -/
theorem incident_command_denied (pid : Str) :
    deny pid "cd ~/taskboard && pkill -f \"tsx server/index.ts\"".toList = true :=
  r1_denies pid _ " pkill -f \"tsx server/index.ts\"".toList (by decide) (by decide)

theorem killall_node_denied (pid : Str) : deny pid "killall node".toList = true :=
  r1_denies pid _ "killall node".toList (by decide) (by decide)

/-! ## Commands that stop the server and are allowed

Each of these would stop the real server (or, for the last one, stop it through a file the guard never reads).
Each theorem holds for every pid. -/

/-- Reads the pid from the lock file instead of writing it out: guard.mjs:28 only matches the literal pid. -/
theorem allowed_kill_cat_pidfile (pid : Str) (hp : PidText pid) :
    deny pid "kill $(cat ~/.taskboard/server.pid)".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

/-- Finds the process with pgrep: the kill is in another part (after "|"), and pgrep is not pkill. -/
theorem allowed_pgrep_xargs (pid : Str) (hp : PidText pid) :
    deny pid "pgrep -f server/index | xargs kill".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

/-- The same with command substitution. -/
theorem allowed_kill_pgrep (pid : Str) (hp : PidText pid) :
    deny pid "kill $(pgrep -f server/index)".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

/-- pkill with a pattern that matches the server's command line ("... tsx server/index.ts") but none of the
listed names: "index.ts" contains neither "server/index" nor the word "tsx". -/
theorem allowed_pkill_index (pid : Str) (hp : PidText pid) :
    deny pid "pkill -f index.ts".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

/-- pkill -f takes a regular expression; "server[/]index" matches "server/index" in the process list but is not
the text "server/index". -/
theorem allowed_pkill_regex (pid : Str) (hp : PidText pid) :
    deny pid "pkill -f 'server[/]index'".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

/-- Any indirection through a file: the guard sees only the command line, not the script's contents. -/
theorem allowed_script (pid : Str) (hp : PidText pid) :
    deny pid "bash ./stop-servers.sh".toList = false := by
  rw [deny_eq_noPid pid _ hp (by decide)]; decide

end Taskboard.Guard
