import Base

# String comparison crosses as native code (src/intrinsics.ts): the same order
# as Base's String.cmp, by code point, at any length.

def s_eq(a: String, b: String) -> Bool:
  String.eq(a, b)

def s_lt(a: String, b: String) -> Bool:
  String.is_lt(a, b)

def s_gt(a: String, b: String) -> Bool:
  String.is_gt(a, b)

# Defs whose emitted names are what the generated helpers would be called
# ($unwind$, $str_order$): the module must still load, with both kinds of name.
def unwind(n: Nat) -> Nat:
  n

def str_order(a: String, b: String) -> Nat:
  0n

def count_eq.add(hit: Bool, n: Nat) -> Nat:
  match hit:
    case True{}:
      (1n + n : Nat)
    case False{}:
      n

def count_eq(+k: String, xs: List<&2, String>) -> Nat:
  match xs:
    case []:
      0n
    case h <> t:
      count_eq.add(String.eq(k, h), count_eq(k, t))
