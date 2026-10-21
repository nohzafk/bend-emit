import Base

# A def that passes a lambda: bend lifts the lambda into a function written
# last in the module, and 2.0.38 closes that function with
# `}export default {` on one line. The module must still be read and load.

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
