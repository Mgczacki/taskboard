/-
Automatic account choice: `pick()` in server/accounts.ts:124-139.

What is modelled:
* `Acct`: the fields `pick` reads. `fullUntil` is the value of `fullUntil(a)` (accounts.ts:87-90; 0 means no usage
  window is at 100% before its reset). `peak` is `peak(a)` (accounts.ts:91). `signedIn` is `status(a).signedIn`
  (accounts.ts:60-75, cached for 60 s).
* `running`: the function passed in by the caller (agents.ts:201, `runningOn`), a count per account id.
* The filter loop (accounts.ts:127-134), the fallback (accounts.ts:135), and the sort (accounts.ts:137). JavaScript's
  `Array.prototype.sort` is stable, so `sort(...)[0]` is the first element, in the original order, that no other
  element sorts before. `best` computes exactly that.

What is abstracted: `peak` is a natural number. In JavaScript it is a float and can be NaN when a usage window has
no `usedPct`; a NaN makes the comparator inconsistent and the sort order unspecified. That case is not modelled.
-/
import Taskboard.Basic

namespace Taskboard.Accounts

inductive Agent where
  | claude | codex
  deriving DecidableEq, Repr

structure Acct where
  id : Nat
  agent : Agent
  isDefault : Bool
  limited : Bool
  fullUntil : Nat
  maxParallel : Nat
  signedIn : Bool
  peak : Nat
  deriving DecidableEq, Repr

/-- The four filters of accounts.ts:128-132. -/
def eligible (r : Nat → Nat) (a : Acct) : Bool :=
  !a.limited && a.fullUntil == 0 && decide (r a.id < a.maxParallel) && a.signedIn

/-- The comparator of accounts.ts:137: `x` sorts before `y` (fewest running, then lowest peak, then default first). -/
def lt (r : Nat → Nat) (x y : Acct) : Bool :=
  decide (r x.id < r y.id) ||
  (decide (r x.id = r y.id) && (decide (x.peak < y.peak) || (decide (x.peak = y.peak) && x.isDefault && !y.isDefault)))

/-- `sort(cmp)[0]` for a stable sort: keep the current choice unless a later element sorts strictly before it. -/
def best (r : Nat → Nat) : Acct → List Acct → Acct
  | b, [] => b
  | b, y :: ys => best r (if lt r y b then y else b) ys

/-- `defaultFor(agent)` (accounts.ts:39). -/
def defaultFor (ag : Agent) (as : List Acct) : Option Acct := as.find? (fun a => a.agent == ag && a.isDefault)

/-- `pick` (accounts.ts:124-139). The second component is true when the fallback of accounts.ts:135 is used. -/
def pick (ag : Agent) (r : Nat → Nat) (as : List Acct) : Option Acct × Bool :=
  match (as.filter (fun a => a.agent == ag)).filter (eligible r) with
  | [] => (defaultFor ag as, true)
  | x :: xs => (some (best r x xs), false)

/-! ## Order lemmas -/

theorem lt_irrefl (r : Nat → Nat) (a : Acct) : lt r a a = false := by
  cases h : a.isDefault <;> simp [lt, h]

theorem lt_trans (r : Nat → Nat) (a b c : Acct) (h1 : lt r a b = true) (h2 : lt r b c = true) : lt r a c = true := by
  cases ha : a.isDefault <;> cases hb : b.isDefault <;> cases hc : c.isDefault <;>
    simp [lt, ha, hb, hc] at h1 h2 ⊢ <;> omega

/-- If `a` sorts before `c`, then for any `b`, `a` sorts before `b` or `b` sorts before `c`. -/
theorem lt_split (r : Nat → Nat) (a b c : Acct) (h : lt r a c = true) : lt r a b = true ∨ lt r b c = true := by
  cases ha : a.isDefault <;> cases hb : b.isDefault <;> cases hc : c.isDefault <;>
    simp [lt, ha, hb, hc] at h ⊢ <;> omega

theorem best_mem (r : Nat → Nat) : ∀ (xs : List Acct) (x : Acct), best r x xs ∈ x :: xs := by
  intro xs
  induction xs with
  | nil => intro x; simp [best]
  | cons y ys ih =>
    intro x
    simp only [best]
    cases h : lt r y x
    · simp only [Bool.false_eq_true, if_false]
      rcases List.mem_cons.mp (ih x) with e | e <;> simp [e]
    · simp only [if_true]
      rcases List.mem_cons.mp (ih y) with e | e <;> simp [e]

/-- Nothing in the list sorts strictly before the chosen element. -/
theorem best_min (r : Nat → Nat) : ∀ (xs : List Acct) (x : Acct), ∀ z ∈ x :: xs, lt r z (best r x xs) = false := by
  intro xs
  induction xs with
  | nil => intro x z hz; simp at hz; subst hz; simp [best, lt_irrefl]
  | cons y ys ih =>
    intro x z hz
    simp only [best]
    by_cases hyx : lt r y x = true
    · simp only [hyx, if_true] at ih ⊢
      have hy := ih y y (by simp)
      simp only [List.mem_cons] at hz
      rcases hz with rfl | rfl | hz
      · -- z = x: if x sorted before the result, y (which sorts before x) would too
        cases hzb : lt r z (best r y ys)
        · rfl
        · have := lt_trans r y z _ hyx hzb; rw [hy] at this; exact absurd this (by simp)
      · exact hy
      · exact ih y z (by simp [hz])
    · have hyx' : lt r y x = false := by simpa using hyx
      simp only [hyx', if_false, Bool.false_eq_true] at ih ⊢
      have hx := ih x x (by simp)
      simp only [List.mem_cons] at hz
      rcases hz with rfl | rfl | hz
      · exact hx
      · cases hzb : lt r z (best r x ys)
        · rfl
        · rcases lt_split r z x _ hzb with h | h
          · rw [hyx'] at h; exact absurd h (by simp)
          · rw [hx] at h; exact absurd h (by simp)
      · exact ih x z (by simp [hz])

theorem not_lt_facts (r : Nat → Nat) (a b : Acct) (h : lt r b a = false) :
    r a.id ≤ r b.id ∧
    (r a.id = r b.id → a.peak ≤ b.peak) ∧
    (r a.id = r b.id → a.peak = b.peak → b.isDefault = true → a.isDefault = true) := by
  cases ha : a.isDefault <;> cases hb : b.isDefault <;> simp [lt, ha, hb] at h <;>
    refine ⟨?_, ?_, ?_⟩ <;> intros <;> first | rfl | omega | simp_all | (exfalso; omega)

/-! ## The three properties -/

/-- **Soundness.** A non-fallback choice is an account of the requested agent that passes all four filters. -/
theorem pick_sound (ag : Agent) (r : Nat → Nat) (as : List Acct) (a : Acct) (h : pick ag r as = (some a, false)) :
    a ∈ as ∧ a.agent = ag ∧ eligible r a = true := by
  unfold pick at h
  split at h
  · simp at h
  · rename_i x xs hok
    simp at h
    have hm : a ∈ x :: xs := h ▸ best_mem r xs x
    rw [← hok] at hm
    simp only [List.mem_filter, beq_iff_eq] at hm
    exact ⟨hm.1.1, hm.1.2, hm.2⟩

/-- **Completeness.** If some account of the agent passes the filters, the fallback is not used. -/
theorem pick_complete (ag : Agent) (r : Nat → Nat) (as : List Acct)
    (h : ∃ a ∈ as, a.agent = ag ∧ eligible r a = true) : (pick ag r as).2 = false := by
  obtain ⟨a, ha, hag, he⟩ := h
  unfold pick
  split
  · rename_i hok
    have : a ∈ (as.filter (fun a => a.agent == ag)).filter (eligible r) := by
      simp [List.mem_filter, ha, hag, he]
    rw [hok] at this; simp at this
  · rfl

/-- **Optimality.** No eligible account of the agent sorts before the choice: none has fewer running tasks; among
equal running counts none has a lower peak; among equal peaks a non-default choice means no default was eligible. -/
theorem pick_optimal (ag : Agent) (r : Nat → Nat) (as : List Acct) (a : Acct) (h : pick ag r as = (some a, false))
    (b : Acct) (hb : b ∈ as) (hag : b.agent = ag) (he : eligible r b = true) :
    r a.id ≤ r b.id ∧
    (r a.id = r b.id → a.peak ≤ b.peak) ∧
    (r a.id = r b.id → a.peak = b.peak → b.isDefault = true → a.isDefault = true) := by
  unfold pick at h
  split at h
  · simp at h
  · rename_i x xs hok
    simp at h
    have hbm : b ∈ x :: xs := by
      rw [← hok]; simp [List.mem_filter, hb, hag, he]
    have hmin := best_min r xs x b hbm
    rw [h] at hmin
    exact not_lt_facts r a b hmin

/-! ## What the filters do not guarantee -/

/-- The fallback ignores every filter: when no account qualifies, the default account is returned even if it is
at its limit and already runs `maxParallel` tasks. `maxParallel` is therefore not a cap. -/
theorem fallback_exceeds_cap :
    let d : Acct := { id := 0, agent := .claude, isDefault := true, limited := true, fullUntil := 0,
                      maxParallel := 8, signedIn := true, peak := 100 }
    let r : Nat → Nat := fun _ => 8
    pick .claude r [d] = (some d, true) ∧ eligible r d = false := by
  decide

/-- Two task starts that run at the same time both call `pick` before either task is stored: `startTask` awaits
`pick` at agents.ts:206 and creates the task at agents.ts:218 (with `await`s in between), and `runningOn`
(agents.ts:201) counts stored tasks. Both calls see the same counts and choose the same account. With one free
slot, the account ends up running two tasks. -/
theorem concurrent_starts_exceed_cap :
    let d : Acct := { id := 0, agent := .claude, isDefault := true, limited := false, fullUntil := 0,
                      maxParallel := 2, signedIn := true, peak := 10 }
    let e : Acct := { id := 1, agent := .claude, isDefault := false, limited := false, fullUntil := 0,
                      maxParallel := 1, signedIn := true, peak := 10 }
    let before : Nat → Nat := fun i => if i = 0 then 2 else 0
    -- both concurrent calls evaluate pick against `before`
    pick .claude before [d, e] = (some e, false) ∧
    -- after both tasks are stored, account 1 runs 2 tasks, above its maxParallel of 1
    before 1 + 2 > e.maxParallel := by
  decide

end Taskboard.Accounts
