import Base
import ./generics.bend as G

# A def with a template parameter: tools/bend_lib.ts skips it.
def pick(~f: Nat -> G.Err, n: Nat) -> G.Err:
  f(n)
