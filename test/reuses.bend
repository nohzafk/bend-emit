import Base
import ./uses.bend as U

# A fixture for the export check: a core that reaches generics.bend only
# through uses.bend, so the module carries generics' defs under the prefix
# uses.bend gives them ("generics."), not one this file writes.

def rewrap(w: U.Wrapped) -> U.Wrapped:
  match w:
    case U.Wrapped{e}:
      U.wrap(e)
