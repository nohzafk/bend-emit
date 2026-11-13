import Base

# Base's Array and Word, a type indexed by a value, a proof field, and a field
# that is a polymorphic function, as they cross to TypeScript.

type Vec<-n: Nat> is Data:
  Vec{xs: List<&2, U32>}

type Fits<-k: U32> is Data:
  Fits{v: U32, ok: {v == k : U32}}

type Box is Type:
  Box{run: @-R: Type -> @k: (U32 -> R) -> R}

type Konst is Type:
  Konst{run: @-R: Type -> U32}

def filled(x: U32) -> Array<U32>:
  Array.new(U32, 2n, x)

def first.go(r: Array<U32> & U32) -> U32:
  (a, v) = r
  v

def first(a: Array<U32>) -> U32:
  first.go(Array.get(U32, a, 0))

def put(a: Array<U32>) -> Array<U32>:
  Array.set(U32, a, 1, 99)

def bits(b: Bool) -> Word(3n):
  WCon{b, WCon{False{}, WCon{True{}, WNil{}}}}

def low(w: Word(3n)) -> Bool:
  match w:
    case WCon{h, t}:
      h

def pair(+x: U32) -> Vec<2n>:
  Vec{[x, x]}

def fits(+x: U32) -> Fits<x>:
  Fits{x, {==}}

def boxed(x: U32) -> Box:
  Box{R => k => k(x)}

def unbox(b: Box) -> U32:
  match b:
    case Box{f}:
      f(U32, y => (y + 10 : U32))

def konst(x: U32) -> Konst:
  Konst{R => x}
