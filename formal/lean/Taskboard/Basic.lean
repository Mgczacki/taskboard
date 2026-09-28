/-
Shared definitions for the Taskboard models.

* `Str` is a string modelled as a list of characters. Lean's `String` is avoided in proofs because list
  induction is simpler; string literals are converted with `.toList`.
* `Status` is the task status type of server/store.ts:8.
-/
namespace Taskboard

abbrev Str := List Char

/-- server/store.ts:8
`'working' | 'needs-you' | 'unread' | 'idle' | 'stopped' | 'review' | 'suspended' | 'parked' | 'archived'` -/
inductive Status where
  | working | needsYou | unread | idle | stopped | review | suspended | parked | archived
  deriving DecidableEq, Repr

/-- Whitespace as removed by JavaScript `String.prototype.trim` (ASCII part only; the Unicode spaces that
`trim` also removes are not modelled). -/
def isWs (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\x0b' || c == '\x0c'

/-- JavaScript `s.trim()` on the ASCII whitespace above. -/
def ltrim (s : Str) : Str := s.dropWhile isWs
def rtrim (s : Str) : Str := (s.reverse.dropWhile isWs).reverse
def trim (s : Str) : Str := rtrim (ltrim s)

/-- `hasInfix a s`: the list `a` occurs as a contiguous part of `s` (JavaScript `s.includes(a)`). -/
def hasInfix (a : Str) : Str → Bool
  | [] => a.isEmpty
  | c :: cs => a.isPrefixOf (c :: cs) || hasInfix a cs

def isDigit (c : Char) : Bool := 48 ≤ c.toNat && c.toNat ≤ 57

end Taskboard
