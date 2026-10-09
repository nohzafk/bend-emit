import Base
import ./laws_core.bend as C
import ./laws_facts.bend as F
import bend-mathlib@0.7.2.0/nat.bend as MN

# A laws file: reference defs and types are runtime; laws, lemmas and what
# needs them are not.

type Duo is Data:
  Duo{left: C.Item, right: C.Item}

def spec_heavier(p: Duo) -> Bool:
  match p:
    case Duo{l, r}:
      C.heavier(l, r)

def spec_double(n: Nat) -> Nat:
  F.twice(n)

# Calls an imported lemma.
def spec_checked(n: Nat) -> Nat:
  %F.twice_zero() : {F.twice(0n) == 0n : Nat}
  n

# Takes a Base type with no TypeScript encoding.
def spec_cmp(c: Cmp) -> Nat:
  0n

# Names a def with no encoding; stays in the module, undeclared.
def spec_cmp_zero() -> Nat:
  spec_cmp(Nat.cmp(1n, 2n))

law double_zero:
  {spec_double(0n) == 0n : Nat}

def double_zero_lemma() -> {spec_double(0n) == 0n : Nat}:
  {==}

def uses_lemma() -> Nat:
  %double_zero_lemma() : {spec_double(0n) == 0n : Nat}
  1n
