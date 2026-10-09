import Base
import ./laws_core.bend as C
import bend-mathlib@0.7.2.0/nat.bend as MN

# A fact file: plain defs, and a lemma (its type is an equation).

def twice(+n: Nat) -> Nat:
  Nat.add(n, n)

def twice_zero() -> {twice(0n) == 0n : Nat}:
  {==}

# Names a lemma, so it is not runtime.
def twice_checked(n: Nat) -> Nat:
  %twice_zero() : {twice(0n) == 0n : Nat}
  twice(n)
