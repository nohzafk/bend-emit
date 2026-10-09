import Base

# A fixture for lazy selectors: a def whose body is a match on one Bool
# parameter returning one of the other parameters is called through a
# conditional, so only the chosen argument is evaluated.

def pick_nat(b: Bool, +x: Nat, +y: Nat) -> Nat:
  match b:
    case True{}:
      x
    case False{}:
      y

def pick_m(-A: Data, b: Bool, x: A, y: A) -> A:
  match b:
    case True{}:
      x
    case False{}:
      y

# A schema-like tree: a Tag arm tries its case, and falls to the rest.
type Cases is Data:
  NoCase{}
  Case{tag: Nat, next: Cases}

# The shape of bend-schema's check: the tag test selects between two
# self-calls. Only the chosen one may run.
def find(cs: Cases, +n: Nat, +depth: Nat) -> Nat:
  match cs:
    case NoCase{}:
      0n
    case Case{tag, next}:
      pick_nat(Nat.is_eq(tag, n), depth, find(next, n, 1n+depth))

# Walks a list to its end; a List reached 100k deep must not overflow.
def len(+xs: List<&2, Nat>, +acc: Nat) -> Nat:
  match xs:
    case Nil{}:
      acc
    case Con{head, tail}:
      pick_nat(Nat.is_eq(head, 0n), len(tail, 1n+acc), len(tail, 1n+acc))

# The unchosen arm cannot be evaluated when the host passes the largest Nat bend
# holds as acc: counting up from it fails at the first step ("a Nat past the
# largest immediate"). Chosen lazily, the call never runs; eagerly, it throws.
def guarded(b: Bool, +xs: List<&2, Nat>, +acc: Nat) -> Nat:
  pick_nat(b, 0n, len(xs, acc))
