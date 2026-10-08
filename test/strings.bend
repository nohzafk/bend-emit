import Base

# String comparison crosses as native code (src/intrinsics.ts): the same order
# as Base's String.cmp, by code point, at any length.

def s_eq(a: String, b: String) -> Bool:
  String.eq(a, b)

def s_lt(a: String, b: String) -> Bool:
  String.is_lt(a, b)

def s_gt(a: String, b: String) -> Bool:
  String.is_gt(a, b)
