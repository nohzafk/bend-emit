import Base

# A def that passes a lambda, and a non-tail call to a def (Nat.is_le): bend
# writes the call's `const $Nat_is_le = $Nat_is_le;` entry last in the
# module, and `export default {` straight after it on the same line. Without
# the entry, the lifted lambda comes last and its closing brace takes that
# place: `}export default {`. The module must still be read and load.

# Count it when it fits, and walk on with what is left.
def take.fit(fits: Bool, next: Nat -> Nat, +left: Nat) -> Nat:
  match fits:
    case True{}:
      1n+next(left)
    case False{}:
      0n

# How many of the sizes, from the front, fit the budget.
def take(sizes: List<&2, Nat>, +budget: Nat) -> Nat:
  match sizes:
    case Nil{}:
      0n
    case Con{+h, t}:
      take.fit(Nat.is_le(h, budget), l => take(t, l), Nat.sub(budget, h))
