import Base
import ./dependent.bend as D

# A core over another's computed type: D.Pick(b) is not a TypeScript type,
# so a def over it stays out of the .d.ts; a plain def is declared.

def zero_of(b: Bool) -> D.Pick(b):
  D.zero(b)

def one() -> Nat:
  1n
