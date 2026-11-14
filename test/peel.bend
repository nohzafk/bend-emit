import Base

# A string walk that only peels heads (src/strpeel.ts): bend-emit carries it as
# (string, index), with no slice per character. Both shapes are here, so the
# gate fails when bend's text for a head or a tail changes and the pass, which
# reads that text, would otherwise do nothing without a word.

def code(c: Char) -> U32:
  match c:
    case Chr{x}:
      x

# A reader: tests the string for "" and reads its head, nothing else.
def first(+s: String) -> U32:
  match s:
    case SNil{}:
      0
    case SCon{c, t}:
      code(c)

# A walker: its tail goes to its next step and to the reader.
def nexts(+s: String, acc: List<U32>) -> List<U32>:
  match s:
    case SNil{}:
      acc
    case SCon{c, t}:
      nexts(t, first(t) <> acc)

# A walker whose tail is also kept as a string: left as bend wrote it.
def tails(+s: String, acc: List<&2, String>) -> List<&2, String>:
  match s:
    case SNil{}:
      acc
    case SCon{c, t}:
      tails(t, t <> acc)

# A walker that matches on the head before it steps: bend binds the tail once
# in each arm, and each one is the next step.
def dots(+s: String, +n: U32) -> U32:
  match s:
    case SNil{}:
      n
    case SCon{c, t}:
      match c:
        case Chr{x}:
          match x:
            case 46:
              dots(t, U32.add(n, 100))
            case _:
              dots(t, U32.add(n, 1))
