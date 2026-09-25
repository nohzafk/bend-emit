import Base

# A generic data type, a type computed from a value, and defs over both:
# tools/bend_lib.ts declares the generic type and the plain defs, and keeps
# the dependent and erased ones in the module, undeclared.

type Two<A: Data, B: Data> is Data:
  Two{a: A, b: B}

def swap(t: Two<Nat, String>) -> Two<String, Nat>:
  match t:
    case Two{a, b}:
      Two{b, a}

def Pick(b: Bool) -> Data:
  match b:
    case True{}:
      Nat
    case False{}:
      String

def zero(b: Bool) -> Pick(b):
  match b:
    case True{}:
      0n
    case False{}:
      ""

def id(-A: Data, x: A) -> A:
  x

def id_nat(n: Nat) -> Nat:
  id(Nat, n)
