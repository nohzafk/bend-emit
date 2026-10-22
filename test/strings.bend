import Base

# String comparison (Base's String.order.go, made native by src/intrinsics.ts):
# by Char code, at any length.

def s_eq(a: String, b: String) -> Bool:
  String.eq(a, b)

# Strings built here from Char codes, so a non-scalar code (a surrogate, or
# past U+10FFFF) is a packed Char: a host string cannot carry one in.
def pk_str(xs: List<U32>) -> String:
  match xs:
    case []:
      SNil{}
    case h <> t:
      SCon{Chr{h}, pk_str(t)}

def pk_eq(xs: List<U32>, ys: List<U32>) -> Bool:
  String.eq(pk_str(xs), pk_str(ys))

def pk_lt(xs: List<U32>, ys: List<U32>) -> Bool:
  String.is_lt(pk_str(xs), pk_str(ys))

def pk_gt(xs: List<U32>, ys: List<U32>) -> Bool:
  String.is_gt(pk_str(xs), pk_str(ys))

def s_lt(a: String, b: String) -> Bool:
  String.is_lt(a, b)

def s_gt(a: String, b: String) -> Bool:
  String.is_gt(a, b)

# Defs whose emitted names are what the generated helpers would be called
# (unwind, str_order): the module must still load, with both kinds of name.
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
