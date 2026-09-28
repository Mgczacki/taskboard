/-
The tmux session listing (server/tmux.ts:22-31) and the reconcile loop that reads it (server/index.ts:554-581).

What is modelled:
* `Pane`: one row that `tmux list-panes -a -F ...` reports (tmux.ts:24), with the seven fields the format asks for.
* `tmuxOutput`: the text tmux prints: one line per pane, each line followed by a newline.
* `listSessions`: the parser at tmux.ts:25-30: `out.trim().split('\n').filter(Boolean).map(l => ... l.split(SEP) ...)`.
* the NEW format joins the fields with the printable separator "|~|" (tmux.ts:22).
* the OLD format joined them with a tab. Under launchd there is no UTF-8 locale, and tmux printed every tab as "_"
  (tmux.ts:8-9). `renderTab` is that rewrite.
* `reconcileNew`: the per-task status decision of index.ts:559-570, including the has-session confirmation at
  index.ts:568. `reconcileOld` is the same decision without that confirmation (the old source is not in the repo;
  this is the version described in the task: a task missing from the listing was marked suspended).
-/
import Taskboard.Basic

namespace Taskboard.Listing
open Taskboard

/-! ## Splitting and joining -/

/-- `joinSep sep fs` is JavaScript `fs.join(sep)`. -/
def joinSep (sep : Str) : List Str → Str
  | [] => []
  | [x] => x
  | x :: y :: ys => x ++ sep ++ joinSep sep (y :: ys)

/-- Helper for `splitOn`. `acc` holds the characters of the current field in reverse order; `skip` counts the
characters of a separator that still have to be passed over. Structural recursion, so that `decide` can evaluate it. -/
def splitAux (sep : Str) : Str → Str → Nat → List Str
  | [], acc, _ => [acc.reverse]
  | _ :: cs, acc, k + 1 => splitAux sep cs acc k
  | c :: cs, acc, 0 =>
    if sep ≠ [] ∧ sep.isPrefixOf (c :: cs) = true then acc.reverse :: splitAux sep cs [] (sep.length - 1)
    else splitAux sep cs (c :: acc) 0

/-- `splitOn sep s` is JavaScript `s.split(sep)` for a non-empty separator: it cuts at the leftmost
occurrence of `sep`, then continues after it. -/
def splitOn (sep s : Str) : List Str := splitAux sep s [] 0

theorem isPrefixOf_self_append (a b : Str) : a.isPrefixOf (a ++ b) = true := by
  induction a with
  | nil => rfl
  | cons x xs ih => simp [ih]

theorem splitAux_skip (sep : Str) (rest acc : Str) :
    ∀ l : Str, splitAux sep (l ++ rest) acc l.length = splitAux sep rest acc 0 := by
  intro l
  induction l with
  | nil => rfl
  | cons x xs ih => simp only [List.cons_append, List.length_cons]; rw [splitAux]; exact ih

/-- Splitting `f ++ sep ++ rest` returns `f` as the first field when `f` does not contain the first character
of `sep`. -/
theorem splitAux_field (s0 : Char) (ss : Str) (rest : Str) :
    ∀ (f acc : Str), s0 ∉ f →
      splitAux (s0 :: ss) (f ++ (s0 :: ss) ++ rest) acc 0 = (acc.reverse ++ f) :: splitAux (s0 :: ss) rest [] 0 := by
  intro f
  induction f with
  | nil =>
    intro acc _
    simp only [List.nil_append, List.cons_append]
    rw [splitAux]
    have hp : (s0 :: ss).isPrefixOf (s0 :: (ss ++ rest)) = true := by
      have := isPrefixOf_self_append (s0 :: ss) rest; simpa using this
    rw [if_pos ⟨by simp, hp⟩]
    simp only [List.length_cons, Nat.add_sub_cancel, List.append_nil]
    rw [splitAux_skip]
  | cons c f ih =>
    intro acc hc
    have hc0 : c ≠ s0 := by intro h; apply hc; simp [h]
    have hf : s0 ∉ f := by intro h; apply hc; simp [h]
    simp only [List.cons_append]
    rw [splitAux]
    split
    · rename_i h2; exfalso; have := h2.2; simp_all [List.isPrefixOf]
    · have := ih (c :: acc) hf
      simp only [List.append_assoc, List.cons_append] at this ⊢
      rw [this]; simp

/-- A last field without the separator's first character comes back whole. -/
theorem splitAux_last (s0 : Char) (ss : Str) :
    ∀ (f acc : Str), s0 ∉ f → splitAux (s0 :: ss) f acc 0 = [acc.reverse ++ f] := by
  intro f
  induction f with
  | nil => intro acc _; simp [splitAux]
  | cons c f ih =>
    intro acc hc
    have hc0 : c ≠ s0 := by intro h; apply hc; simp [h]
    have hf : s0 ∉ f := by intro h; apply hc; simp [h]
    rw [splitAux]
    split
    · rename_i h2; exfalso; have := h2.2; simp_all [List.isPrefixOf]
    · rw [ih (c :: acc) hf]; simp

/-- `split` undoes `join` when no field contains the separator's first character. -/
theorem split_join (s0 : Char) (ss : Str) :
    ∀ (fs : List Str), fs ≠ [] → (∀ f ∈ fs, s0 ∉ f) → splitOn (s0 :: ss) (joinSep (s0 :: ss) fs) = fs := by
  intro fs
  induction fs with
  | nil => intro h; exact absurd rfl h
  | cons x xs ih =>
    intro _ hall
    cases xs with
    | nil =>
      simp only [joinSep, splitOn]
      rw [splitAux_last s0 ss x [] (hall x (by simp))]; simp
    | cons y ys =>
      simp only [joinSep, splitOn]
      rw [splitAux_field s0 ss _ x [] (hall x (by simp))]
      have := ih (by simp) (fun f hf => hall f (by simp [hf]))
      simp only [splitOn] at this
      simp [this]

/-! ## Numbers -/

def digitChar : Nat → Char
  | 0 => '0' | 1 => '1' | 2 => '2' | 3 => '3' | 4 => '4'
  | 5 => '5' | 6 => '6' | 7 => '7' | 8 => '8' | _ => '9'

/-- The decimal text tmux prints for a number (`fuel` bounds the recursion; `digits` gives enough). -/
def digitsAux : Nat → Nat → Str
  | 0, _ => []
  | fuel + 1, n => if n < 10 then [digitChar n] else digitsAux fuel (n / 10) ++ [digitChar (n % 10)]

def digits (n : Nat) : Str := digitsAux (n + 1) n

/-- Value of one digit character. -/
def charVal (c : Char) : Nat := c.toNat - 48

/-- Decimal value of a digit string (left to right). -/
def ofDigitsAux (acc : Nat) : Str → Nat
  | [] => acc
  | c :: cs => ofDigitsAux (acc * 10 + charVal c) cs

/-- JavaScript `Number(field)` for the fields used here: `undefined` (a missing field) gives NaN, modelled as
`none`; a string of digits gives its value (the empty string gives 0); anything else gives NaN. -/
def parseNum : Option Str → Option Nat
  | none => none
  | some s => if s.all isDigit then some (ofDigitsAux 0 s) else none

theorem digitChar_val (d : Nat) (h : d < 10) : charVal (digitChar d) = d := by
  match d, h with
  | 0, _ => rfl | 1, _ => rfl | 2, _ => rfl | 3, _ => rfl | 4, _ => rfl
  | 5, _ => rfl | 6, _ => rfl | 7, _ => rfl | 8, _ => rfl | 9, _ => rfl

theorem digitChar_isDigit (d : Nat) : isDigit (digitChar d) = true := by
  match d with
  | 0 => rfl | 1 => rfl | 2 => rfl | 3 => rfl | 4 => rfl
  | 5 => rfl | 6 => rfl | 7 => rfl | 8 => rfl | _ + 9 => simp [digitChar]; decide

theorem ofDigitsAux_single (acc : Nat) (c : Char) : ofDigitsAux acc [c] = acc * 10 + charVal c := rfl

theorem ofDigitsAux_snoc (l : Str) (c : Char) (acc : Nat) :
    ofDigitsAux acc (l ++ [c]) = ofDigitsAux acc l * 10 + charVal c := by
  induction l generalizing acc with
  | nil => exact ofDigitsAux_single acc c
  | cons x xs ih => exact ih _

theorem digitsAux_val : ∀ fuel n, n < fuel → ofDigitsAux 0 (digitsAux fuel n) = n := by
  intro fuel
  induction fuel with
  | zero => intro n h; omega
  | succ f ih =>
    intro n h
    rw [digitsAux]
    split
    · rw [ofDigitsAux_single, digitChar_val n (by omega)]; omega
    · rw [ofDigitsAux_snoc, ih (n / 10) (by omega), digitChar_val (n % 10) (by omega)]; omega

theorem digits_val (n : Nat) : ofDigitsAux 0 (digits n) = n := digitsAux_val (n + 1) n (by omega)

theorem digitsAux_all : ∀ fuel n, ∀ c ∈ digitsAux fuel n, isDigit c = true := by
  intro fuel
  induction fuel with
  | zero => intro n c h; simp [digitsAux] at h
  | succ f ih =>
    intro n c hc
    rw [digitsAux] at hc
    split at hc
    · simp at hc; subst hc; exact digitChar_isDigit n
    · simp only [List.mem_append, List.mem_singleton] at hc
      rcases hc with h | h
      · exact ih _ c h
      · subst h; exact digitChar_isDigit _

theorem digits_all (n : Nat) : ∀ c ∈ digits n, isDigit c = true := digitsAux_all _ _

theorem parseNum_digits (n : Nat) : parseNum (some (digits n)) = some n := by
  simp only [parseNum]
  rw [if_pos (List.all_eq_true.mpr (digits_all n)), digits_val]

theorem not_mem_digits (c : Char) (hc : isDigit c = false) (n : Nat) : c ∉ digits n := by
  intro h; have := digits_all n c h; simp [hc] at this

/-! ## Panes, lines and the parser -/

/-- One pane row as tmux knows it (tmux.ts:24): session name, window activity (seconds), bell flag, pane pid,
pane dead flag, alternate screen flag, mouse flag. -/
structure Pane where
  name : Str
  activity : Nat
  bell : Bool
  pid : Nat
  dead : Bool
  alt : Bool
  mouse : Bool
  deriving DecidableEq, Repr

/-- `SessionInfo` (tmux.ts:20) as the parser builds it. `none` in a number field stands for JavaScript NaN. -/
structure Info where
  name : Str
  activity : Option Nat
  bell : Bool
  panePid : Option Nat
  dead : Bool
  unscrollable : Bool
  deriving DecidableEq, Repr

/-- What the parser is meant to produce for a pane (tmux.ts:29). -/
def Pane.info (p : Pane) : Info :=
  { name := p.name, activity := some (p.activity * 1000), bell := p.bell, panePid := some p.pid,
    dead := p.dead, unscrollable := p.alt && !p.mouse }

def boolStr (b : Bool) : Str := if b then ['1'] else ['0']

def fields (p : Pane) : List Str :=
  [p.name, digits p.activity, boolStr p.bell, digits p.pid, boolStr p.dead, boolStr p.alt, boolStr p.mouse]

/-- The NEW separator (tmux.ts:22). -/
def SEP : Str := "|~|".toList
/-- The OLD separator. -/
def TAB : Str := ['\t']

/-- What tmux prints under a non-UTF-8 locale: every tab becomes "_". -/
def renderTab (s : Str) : Str := s.map (fun c => if c = '\t' then '_' else c)

def lineNew (p : Pane) : Str := joinSep SEP (fields p)
def lineOld (p : Pane) : Str := renderTab (joinSep TAB (fields p))

/-- tmux output: each line followed by a newline. -/
def tmuxOutput (line : Pane → Str) (ps : List Pane) : Str := (ps.map (fun p => line p ++ ['\n'])).flatten

/-- tmux.ts:26-29 for one line, with the separator as a parameter. -/
def parseLine (sep : Str) (l : Str) : Info :=
  let f := splitOn sep l
  { name := (f[0]?).getD [],
    activity := (parseNum f[1]?).map (· * 1000),
    bell := f[2]? == some ['1'],
    panePid := parseNum f[3]?,
    dead := f[4]? == some ['1'],
    unscrollable := f[5]? == some ['1'] && !(f[6]? == some ['1']) }

/-- tmux.ts:24-30. `out = none` is a failed tmux command (`tmuxQuiet` returns null, tmux.ts:16-18). -/
def listSessions (sep : Str) : Option Str → List Info
  | none => []
  | some out => if out = [] then [] else ((splitOn ['\n'] (trim out)).filter (fun l => !l.isEmpty)).map (parseLine sep)

/-! ## Lines survive trim / split / filter -/

def StartsOK (l : Str) : Prop := ∃ c r, l = c :: r ∧ isWs c = false
def EndsOK (l : Str) : Prop := ∃ r c, l = r ++ [c] ∧ isWs c = false
/-- A printed line that the line splitting keeps intact. -/
def LineOK (l : Str) : Prop := StartsOK l ∧ EndsOK l ∧ '\n' ∉ l

theorem EndsOK.append_left {b : Str} (a : Str) (h : EndsOK b) : EndsOK (a ++ b) := by
  obtain ⟨r, c, rfl, hc⟩ := h; exact ⟨a ++ r, c, by simp, hc⟩

theorem StartsOK.append_right {a : Str} (b : Str) (h : StartsOK a) : StartsOK (a ++ b) := by
  obtain ⟨c, r, rfl, hc⟩ := h; exact ⟨c, r ++ b, by simp, hc⟩

theorem joinSep_ends (sep : Str) : ∀ ls : List Str, ls ≠ [] → (∀ l ∈ ls, EndsOK l) → EndsOK (joinSep sep ls) := by
  intro ls
  induction ls with
  | nil => intro h; exact absurd rfl h
  | cons x xs ih =>
    intro _ h
    cases xs with
    | nil => simpa [joinSep] using h x (by simp)
    | cons y ys =>
      simp only [joinSep]
      rw [List.append_assoc]
      exact EndsOK.append_left _ (EndsOK.append_left _ (ih (by simp) (fun l hl => h l (by simp [hl]))))

theorem joinSep_starts (sep : Str) (x : Str) (xs : List Str) (h : StartsOK x) : StartsOK (joinSep sep (x :: xs)) := by
  cases xs with
  | nil => simpa [joinSep] using h
  | cons y ys => simp only [joinSep]; rw [List.append_assoc]; exact StartsOK.append_right _ h

theorem joinSep_not_mem (sep : Str) (c : Char) (hs : c ∉ sep) :
    ∀ ls : List Str, (∀ l ∈ ls, c ∉ l) → c ∉ joinSep sep ls := by
  intro ls
  induction ls with
  | nil => intro _; simp [joinSep]
  | cons x xs ih =>
    intro h
    cases xs with
    | nil => simpa [joinSep] using h x (by simp)
    | cons y ys =>
      simp only [joinSep, List.mem_append, not_or]
      exact ⟨⟨h x (by simp), hs⟩, ih (fun l hl => h l (by simp [hl]))⟩

theorem flatten_eq_join (ls : List Str) (h : ls ≠ []) :
    (ls.map (fun l => l ++ ['\n'])).flatten = joinSep ['\n'] ls ++ ['\n'] := by
  induction ls with
  | nil => exact absurd rfl h
  | cons x xs ih =>
    cases xs with
    | nil => simp [joinSep]
    | cons y ys =>
      have := ih (by simp)
      simp only [List.map_cons, List.flatten_cons] at this ⊢
      rw [this]; simp [joinSep]

theorem ltrim_starts (l : Str) (h : StartsOK l) : ltrim l = l := by
  obtain ⟨c, r, rfl, hc⟩ := h
  simp [ltrim, List.dropWhile_cons, hc]

theorem rtrim_nl (l : Str) (h : EndsOK l) : rtrim (l ++ ['\n']) = l := by
  obtain ⟨r, c, rfl, hc⟩ := h
  have hn : isWs '\n' = true := by decide
  simp [rtrim, List.dropWhile_cons, hn, hc]

/-- The line splitting in `listSessions` gives back exactly the printed lines, provided every line starts and
ends with a non-whitespace character and has no newline. -/
theorem lines_roundtrip (sep : Str) (L : Pane → Str) (ps : List Pane) (hps : ps ≠ [])
    (hok : ∀ p ∈ ps, LineOK (L p)) :
    listSessions sep (some (tmuxOutput L ps)) = (ps.map L).map (parseLine sep) := by
  have hls : ps.map L ≠ [] := by simpa using hps
  have hall : ∀ l ∈ ps.map L, LineOK l := by
    intro l hl; simp only [List.mem_map] at hl; obtain ⟨p, hp, rfl⟩ := hl; exact hok p hp
  have hout : tmuxOutput L ps = joinSep ['\n'] (ps.map L) ++ ['\n'] := by
    unfold tmuxOutput
    rw [← flatten_eq_join _ hls]; simp [Function.comp_def]
  obtain ⟨x, xs, hx⟩ : ∃ x xs, ps.map L = x :: xs := by
    cases h : ps.map L with
    | nil => exact absurd h hls
    | cons x xs => exact ⟨x, xs, rfl⟩
  have hstart : StartsOK (joinSep ['\n'] (ps.map L) ++ ['\n']) := by
    rw [hx]; exact StartsOK.append_right _ (joinSep_starts _ x xs (hall x (by simp [hx])).1)
  have hend : EndsOK (joinSep ['\n'] (ps.map L)) := joinSep_ends _ _ hls (fun l hl => (hall l hl).2.1)
  have hne : tmuxOutput L ps ≠ [] := by rw [hout]; simp
  simp only [listSessions, hne, if_false]
  rw [hout, trim, ltrim_starts _ hstart, rtrim_nl _ hend,
      split_join '\n' [] _ hls (fun l hl => (hall l hl).2.2)]
  have hf : (ps.map L).filter (fun l => !l.isEmpty) = ps.map L := by
    apply List.filter_eq_self.mpr
    intro l hl
    obtain ⟨c, r, rfl, _⟩ := (hall l hl).1
    simp
  rw [hf]

/-! ## NEW format: parse (format xs) = xs -/

/-- Conditions on a session name. Taskboard names are `task-<n>` (server/agents.ts:220, :264) and
`tb-controller` (agents.ts:96); they satisfy all three. -/
structure NameOK (n : Str) : Prop where
  starts : StartsOK n
  noBar : '|' ∉ n
  noNl : '\n' ∉ n

theorem boolStr_ends (b : Bool) : EndsOK (boolStr b) := by
  cases b
  · exact ⟨[], '0', rfl, by decide⟩
  · exact ⟨[], '1', rfl, by decide⟩

theorem not_mem_boolStr (c : Char) (h0 : c ≠ '0') (h1 : c ≠ '1') (b : Bool) : c ∉ boolStr b := by
  cases b <;> simp [boolStr, h0, h1]

theorem fields_no (c : Char) (hd : isDigit c = false) (h0 : c ≠ '0') (h1 : c ≠ '1') (p : Pane) (hn : c ∉ p.name) :
    ∀ f ∈ fields p, c ∉ f := by
  intro f hf
  simp only [fields, List.mem_cons, List.mem_nil_iff, or_false] at hf
  rcases hf with rfl | rfl | rfl | rfl | rfl | rfl | rfl
  · exact hn
  all_goals first
    | exact not_mem_digits c hd _
    | exact not_mem_boolStr c h0 h1 _

theorem fields_ends (p : Pane) : EndsOK (joinSep SEP (fields p)) := by
  simp only [fields, joinSep, List.append_assoc]
  repeat apply EndsOK.append_left
  exact boolStr_ends _

theorem lineNew_ok (p : Pane) (h : NameOK p.name) : LineOK (lineNew p) := by
  refine ⟨?_, fields_ends p, ?_⟩
  · exact joinSep_starts _ _ _ h.starts
  · exact joinSep_not_mem SEP '\n' (by decide) _ (fields_no '\n' (by decide) (by decide) (by decide) p h.noNl)

theorem parseLine_new (p : Pane) (h : NameOK p.name) : parseLine SEP (lineNew p) = p.info := by
  have hs : splitOn SEP (lineNew p) = fields p :=
    split_join '|' ['~', '|'] (fields p) (by simp [fields])
      (fields_no '|' (by decide) (by decide) (by decide) p h.noBar)
  simp only [parseLine, hs, fields]
  simp [parseNum_digits, Pane.info]
  cases p.bell <;> cases p.dead <;> cases p.alt <;> cases p.mouse <;> simp [boolStr]

/-- **Listing theorem (NEW format).** For every list of panes whose names satisfy `NameOK`, parsing what tmux
prints gives back exactly the intended session records, in order. -/
theorem listing_roundtrip_new (ps : List Pane) (h : ∀ p ∈ ps, NameOK p.name) :
    listSessions SEP (some (tmuxOutput lineNew ps)) = ps.map Pane.info := by
  cases ps with
  | nil => simp [listSessions, tmuxOutput]
  | cons q qs =>
    rw [lines_roundtrip SEP lineNew _ (by simp) (fun p hp => lineNew_ok p (h p hp))]
    simp only [List.map_map]
    apply List.map_congr_left
    intro p hp
    exact parseLine_new p (h p hp)

/-- The NameOK condition is needed: a name ending in "|~" is split wrongly. The comment at tmux.ts:22 says
"session names never contain it" (the separator), but "x|~" does not contain "|~|" and still breaks the parse:
the parser returns the name "x". Taskboard's own names (`task-<n>`) never contain "|", so this does not happen
with the current naming. -/
theorem listing_name_counterexample :
    let p : Pane := { name := "x|~".toList, activity := 5, bell := false, pid := 7, dead := false, alt := false, mouse := false }
    (listSessions SEP (some (tmuxOutput lineNew [p]))).map (·.name) = ["x".toList] := by
  decide

/-! ## OLD format: the incident -/

/-- What the OLD parser returns for one rendered line: the whole line becomes the name, every other field is
missing, so `dead` is false and the numbers are NaN. -/
def oldInfo (l : Str) : Info :=
  { name := l, activity := none, bell := false, panePid := none, dead := false, unscrollable := false }

theorem not_tab_renderTab (s : Str) : '\t' ∉ renderTab s := by
  simp only [renderTab, List.mem_map, not_exists, not_and]
  intro c _; split <;> simp_all

theorem lineOld_ok (p : Pane) (h : NameOK p.name) : LineOK (lineOld p) := by
  have hj : LineOK (joinSep TAB (fields p)) :=
    ⟨joinSep_starts _ _ _ h.starts,
     by simp only [fields, joinSep, List.append_assoc]; repeat apply EndsOK.append_left
        exact boolStr_ends _,
     joinSep_not_mem TAB '\n' (by decide) _ (fields_no '\n' (by decide) (by decide) (by decide) p h.noNl)⟩
  obtain ⟨⟨c, r, hcr, hc⟩, ⟨r2, c2, hrc, hc2⟩, hn⟩ := hj
  have hct : c ≠ '\t' := by intro e; subst e; simp [isWs] at hc
  have hc2t : c2 ≠ '\t' := by intro e; subst e; simp [isWs] at hc2
  refine ⟨⟨c, renderTab r, ?_, hc⟩, ⟨renderTab r2, c2, ?_, hc2⟩, ?_⟩
  · simp [lineOld, hcr, renderTab, hct]
  · simp [lineOld, hrc, renderTab, hc2t]
  · simp only [lineOld, renderTab, List.mem_map, not_exists, not_and]
    intro x hx; split
    · simp
    · intro e; subst e; exact hn hx

theorem parseLine_old (p : Pane) : parseLine TAB (lineOld p) = oldInfo (lineOld p) := by
  have : splitOn TAB (lineOld p) = [lineOld p] := by
    simp only [splitOn, TAB]; rw [splitAux_last '\t' [] (lineOld p) [] (by unfold lineOld; exact not_tab_renderTab _)]; simp
  simp [parseLine, this, oldInfo, parseNum]

/-- Every OLD line contains "_": the rendered tab after the name. -/
theorem underscore_in_lineOld (p : Pane) : '_' ∈ lineOld p := by
  simp only [lineOld, fields, joinSep, renderTab, List.map_append, List.mem_append, TAB]
  simp

/-- **Incident theorem, part 1.** With the OLD format under a non-UTF-8 locale, the parser returns one record
per pane whose name is the whole printed line. Every such name contains "_". -/
theorem listing_old (ps : List Pane) (h : ∀ p ∈ ps, NameOK p.name) :
    listSessions TAB (some (tmuxOutput lineOld ps)) = ps.map (fun p => oldInfo (lineOld p)) := by
  cases ps with
  | nil => simp [listSessions, tmuxOutput]
  | cons q qs =>
    rw [lines_roundtrip TAB lineOld _ (by simp) (fun p hp => lineOld_ok p (h p hp))]
    simp only [List.map_map]
    apply List.map_congr_left
    intro p hp; exact parseLine_old p

theorem listing_old_names (ps : List Pane) (h : ∀ p ∈ ps, NameOK p.name) :
    ∀ s ∈ listSessions TAB (some (tmuxOutput lineOld ps)), '_' ∈ s.name := by
  rw [listing_old ps h]
  intro s hs
  simp only [List.mem_map] at hs
  obtain ⟨p, _, rfl⟩ := hs
  exact underscore_in_lineOld p

/-! ## The reconcile decision -/

/-- `new Map(sessions.map(s => [s.name, s]))` then `byName.get(name)` (index.ts:556, :561): when several records
have the same name, the last one wins. -/
def lookupLast (n : Str) : List Info → Option Info
  | [] => none
  | s :: rest => match lookupLast n rest with
    | some r => some r
    | none => if s.name = n then some s else none

theorem lookupLast_spec (n : Str) : ∀ (l : List Info) (s : Info), lookupLast n l = some s → s ∈ l ∧ s.name = n := by
  intro l
  induction l with
  | nil => intro s h; simp [lookupLast] at h
  | cons x xs ih =>
    intro s h
    simp only [lookupLast] at h
    cases hr : lookupLast n xs with
    | some r =>
      rw [hr] at h
      have e : r = s := by simpa using h
      subst e
      exact ⟨List.mem_cons_of_mem _ (ih _ hr).1, (ih _ hr).2⟩
    | none =>
      rw [hr] at h
      by_cases hx : x.name = n
      · simp [hx] at h; subst h; exact ⟨by simp, hx⟩
      · simp [hx] at h

theorem lookupLast_none (n : Str) : ∀ (l : List Info), (∀ s ∈ l, s.name ≠ n) → lookupLast n l = none := by
  intro l
  induction l with
  | nil => intro _; rfl
  | cons x xs ih =>
    intro h
    simp only [lookupLast]
    rw [ih (fun s hs => h s (by simp [hs]))]
    simp [h x (by simp)]

/-- index.ts:559-570 for a task that is not the controller, not open in another terminal and not being launched.
The result is the status reconcile writes, or `none` when it leaves the status alone.
`hasSession` is the answer of `tmux has-session -t =name` (tmux.ts:33-35); it is only asked when the task is
missing from the listing. -/
def reconcileNew (st : Status) (listing : List Info) (name : Str) (hasSession : Bool) : Option Status :=
  if st = .archived ∨ st = .parked then none
  else match lookupLast name listing with
    | some s =>
      if st = .suspended then (if !s.dead then some .idle else none)
      else if s.dead then some .suspended else none
    | none =>
      if st = .suspended then none
      else if hasSession then none else some .suspended

/-- The decision before the has-session confirmation existed: a task missing from the listing is suspended. -/
def reconcileOld (st : Status) (listing : List Info) (name : Str) : Option Status :=
  if st = .archived ∨ st = .parked then none
  else match lookupLast name listing with
    | some s => if st = .suspended then none else if s.dead then some .suspended else none
    | none => if st = .suspended then none else some .suspended

/-- The real state of tmux: for each name, `none` (no session) or `some dead` (session exists; `dead` is
`#{pane_dead}`, which is 1 when the agent exited and the pane stays because of remain-on-exit, agents.ts / tmux.ts:53). -/
abbrev World := Str → Option Bool

/-- **Reconcile theorem.** If the session is live and has-session answers truthfully, reconcile never marks the
task suspended, whatever the listing contains (missing entries, garbled names, duplicates, wrong numbers),
as long as the listing does not report this very name with the dead flag set. -/
theorem reconcile_never_suspends_live (w : World) (st : Status) (listing : List Info) (n : Str)
    (hlive : w n = some false)
    (hdead : ∀ s ∈ listing, s.name = n → s.dead = false) :
    reconcileNew st listing n (w n).isSome ≠ some .suspended := by
  unfold reconcileNew
  split
  · simp
  · split
    · rename_i s hs
      have ⟨hm, hn⟩ := lookupLast_spec n listing s hs
      have hd := hdead s hm hn
      split
      · split <;> simp
      · simp [hd]
    · simp [hlive]

/-- The side condition above is needed: the dead flag in the listing is trusted without confirmation. A listing
that wrongly reports the live session as dead makes reconcile suspend it. -/
theorem reconcile_trusts_dead_flag :
    let w : World := fun n => if n = "task-1".toList then some false else none
    let bad : Info := { name := "task-1".toList, activity := none, bell := false, panePid := none, dead := true, unscrollable := false }
    w "task-1".toList = some false ∧
      reconcileNew .working [bad] "task-1".toList (w "task-1".toList).isSome = some .suspended := by
  decide

/-- **tmux errors look like "no session".** `tmuxQuiet` (tmux.ts:16-18) turns every failure of the tmux command
into `null`: then `listSessions` returns `[]` (tmux.ts:25) and `hasSession` returns false (tmux.ts:34). If tmux
cannot be run at all (binary not found, wrong socket permissions, any error), reconcile marks every active task
suspended although its session may be running. The has-session check does not protect against this, because
it goes through the same error path. -/
theorem tmux_failure_suspends_all (st : Status) (n : Str)
    (h : st ≠ .archived ∧ st ≠ .parked ∧ st ≠ .suspended) :
    reconcileNew st (listSessions SEP none) n false = some .suspended := by
  obtain ⟨h1, h2, h3⟩ := h
  simp [reconcileNew, listSessions, lookupLast, h1, h2, h3]

/-- **Incident theorem, part 2.** With the OLD format, OLD reconcile and a `_`-free task name (all Taskboard
names), every task that is not archived, parked or already suspended is marked suspended, for every state of
tmux. -/
theorem incident_old (ps : List Pane) (hps : ∀ p ∈ ps, NameOK p.name) (st : Status) (n : Str) (hn : '_' ∉ n)
    (h : st ≠ .archived ∧ st ≠ .parked ∧ st ≠ .suspended) :
    reconcileOld st (listSessions TAB (some (tmuxOutput lineOld ps))) n = some .suspended := by
  obtain ⟨h1, h2, h3⟩ := h
  have hnone : lookupLast n (listSessions TAB (some (tmuxOutput lineOld ps))) = none := by
    apply lookupLast_none
    intro s hs e
    have := listing_old_names ps hps s hs
    rw [e] at this; exact hn this
  simp [reconcileOld, hnone, h1, h2, h3]

/-- With the same broken listing, the current reconcile (has-session confirmation) leaves live tasks alone. -/
theorem incident_new_reconcile (w : World) (ps : List Pane) (hps : ∀ p ∈ ps, NameOK p.name) (st : Status) (n : Str)
    (hlive : w n = some false) :
    reconcileNew st (listSessions TAB (some (tmuxOutput lineOld ps))) n (w n).isSome ≠ some .suspended := by
  apply reconcile_never_suspends_live w st _ n hlive
  intro s hs _
  rw [listing_old ps hps] at hs
  simp only [List.mem_map] at hs
  obtain ⟨p, _, rfl⟩ := hs
  rfl

/-- **Recovery loses the status.** index.ts:563-564 brings a suspended task with a running session back as
`idle`, not as the status it had. A task that needed you, then went through one bad reconcile pass (for example
a tmux error) and one good pass, ends `idle`: the "needs you" signal is gone. -/
theorem recovery_forgets_needs_you :
    let live : Info := { name := "task-1".toList, activity := some 0, bell := false, panePid := some 1, dead := false, unscrollable := false }
    reconcileNew .needsYou [] "task-1".toList false = some .suspended ∧
      reconcileNew .suspended [live] "task-1".toList true = some .idle := by
  decide

end Taskboard.Listing
