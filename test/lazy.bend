import Base

# A fixture for lazy arguments (src/lazy.ts): a call whose result only some
# paths read runs on those paths alone.

# Walks a list to its end. A step fails when the host passes the largest Nat
# bend holds as acc ("a Nat past the largest immediate"), so a call to len
# that runs is a call that throws: that is how the tests see one run.
def len(+xs: List<&2, Nat>, +acc: Nat) -> Nat:
  match xs:
    case Nil{}:
      acc
    case Con{head, tail}:
      len(tail, 1n+acc)

type Found is Data:
  Hit{at: Nat}
  Miss{seen: Nat}

# A helper def: one arm builds a value, the other hands back the rest of the
# search, which it was given as an argument.
def put(hit: Bool, +at: Nat, rest: Found) -> Found:
  match hit:
    case True{}:
      Hit{at}
    case False{}:
      rest

# The first place n stands at. The search of the tail may run only on a miss.
def search(xs: List<&2, Nat>, +n: Nat, +at: Nat) -> Found:
  match xs:
    case Nil{}:
      Miss{at}
    case Con{head, tail}:
      put(Nat.is_eq(head, n), at, search(tail, n, 1n+at))

# The same through a second helper, which only hands its arguments on.
def put_on(hit: Bool, +at: Nat, rest: Found) -> Found:
  put(hit, at, rest)

def search_on(xs: List<&2, Nat>, +n: Nat, +at: Nat) -> Found:
  match xs:
    case Nil{}:
      Miss{at}
    case Con{head, tail}:
      put_on(Nat.is_eq(head, n), at, search_on(tail, n, 1n+at))

# A helper that opens one of its arguments: the name it binds gets a new name
# where its body is placed.
def near(w: Found, rest: Found) -> Found:
  match w:
    case Hit{at}:
      Hit{at}
    case Miss{seen}:
      rest

def search_near(xs: List<&2, Nat>, +n: Nat, +at: Nat) -> Found:
  match xs:
    case Nil{}:
      Miss{at}
    case Con{head, tail}:
      near(put(Nat.is_eq(head, n), at, Miss{at}), search_near(tail, n, 1n+at))

# A helper that reads the rest on every path (it matches on it) and the
# count on one: the rest stays a loop step, 100k deep.
def tally(rest: Found, +n: Nat) -> Found:
  match rest:
    case Hit{at}:
      Hit{at}
    case Miss{seen}:
      Miss{Nat.add(seen, n)}

def count(xs: List<&2, Nat>) -> Found:
  match xs:
    case Nil{}:
      Miss{0n}
    case Con{head, tail}:
      tally(count(tail), len(Nil{}, head))

# Bool.or and Bool.and: the right side runs only when the left does not decide.
def has(+n: Nat, xs: List<&2, Nat>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{head, tail}:
      Bool.or(Nat.is_eq(n, head), has(n, tail))

def all_are(+n: Nat, xs: List<&2, Nat>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{head, tail}:
      Bool.and(Nat.is_eq(n, head), all_are(n, tail))

def or_len(b: Bool, +xs: List<&2, Nat>, +acc: Nat) -> Bool:
  Bool.or(b, Nat.is_eq(len(xs, acc), 0n))

def and_len(b: Bool, +xs: List<&2, Nat>, +acc: Nat) -> Bool:
  Bool.and(b, Nat.is_eq(len(xs, acc), 0n))

# A walk over a string that hands its tail to a def that reads only the head.
# strpeel carries that tail as an index; with after_dot's body placed in
# dotted, the tail would be read there and sliced again. dotted is left eager.
def code(c: Char) -> U32:
  match c:
    case Chr{x}:
      x

def bump(n: U32) -> U32:
  U32.add(n, 1)

def after_dot(+s: String, +r: U32) -> U32:
  match s:
    case SNil{}:
      r
    case SCon{c, t}:
      code(c)

def dotted(+s: String, +n: U32) -> U32:
  match s:
    case SNil{}:
      0
    case SCon{c, t}:
      match c:
        case Chr{x}:
          match x:
            case 46:
              after_dot(t, bump(n))
            case _:
              dotted(t, n)
