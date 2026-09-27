import Base

# A fixture for the String.reverse lowering: Base's reverse, and a def of its
# own with the same loop, both built into a module whose strings must be flat.

def rev(s: String) -> String:
  String.reverse(s)

# The same loop as Base's, written here: prepend each character to acc.
def rev_onto(s: String, acc: String) -> String:
  match s:
    case SNil{}:
      acc
    case SCon{c, t}:
      rev_onto(t, SCon{c, acc})
