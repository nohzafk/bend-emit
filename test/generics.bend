import Base

# A fixture for tools/bend_lib.ts: Base's generic types on the boundary, in the
# shape a validating core takes -- a list in, the first error or a value out.

type Err is Data:
  Empty{}
  TooBig{index: Nat, got: Nat}

def big_at(ok: Bool, +x: Nat, +i: Nat, rest: Maybe<&2, Err>) -> Maybe<&2, Err>:
  match ok:
    case True{}:
      rest
    case False{}:
      Some{TooBig{i, x}}

def first_big(xs: List<&2, Nat>, +lim: Nat, +i: Nat) -> Maybe<&2, Err>:
  match xs:
    case Nil{}:
      None{}
    case +x <> t:
      big_at(Nat.is_le(x, lim), x, i, first_big(t, lim, Nat.add(i, 1n)))

def total(xs: List<&2, Nat>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case x <> t:
      Nat.add(x, total(t))

def decide(m: Maybe<&2, Err>, +n: Nat) -> Result<&2, &2, Err, Nat>:
  match m:
    case None{}:
      Done{n}
    case Some{e}:
      Fail{e}

def sum_or_err(xs: List<&2, Nat>, +lim: Nat) -> Result<&2, &2, Err, Nat>:
  match xs:
    case Nil{}:
      Fail{Empty{}}
    case +x <> +t:
      decide(first_big(x <> t, lim, 0n), total(x <> t))

def side(+b: Bool, +n: Nat) -> Either<Nat, Bool>:
  match b:
    case True{}:
      Inl{n}
    case False{}:
      Inr{b}

def unit(+n: Nat) -> Unit:
  Unit{}

def unwrap(m: Maybe<Nat>, +d: Nat) -> Nat:
  match m:
    case None{}:
      d
    case Some{v}:
      v
