import Base
import ./generics.bend as G

# A fixture for tools/bend_lib.ts: a core that imports another, and whose defs
# take and return the imported module's types.

type Wrapped is Data:
  Wrapped{err: G.Err}

def wrap(e: G.Err) -> Wrapped:
  Wrapped{e}

def first_or_none(xs: List<&2, Nat>, +lim: Nat) -> Maybe<&2, G.Err>:
  G.first_big(xs, lim, 0n)
