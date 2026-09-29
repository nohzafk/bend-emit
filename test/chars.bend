import Base

# Char crosses to TypeScript as a string of one code point, and a type body may
# hold comments and blank lines, as bend allows.

type Sort is Data:
  # a character with no meaning of its own
  Other{c: Char}

  # the two with one
  Quote{}
  Sep{}

def kind.go(+q: Bool, +s: Bool, +c: Char) -> Sort:
  match q:
    case True{}:
      Quote{}
    case False{}:
      match s:
        case True{}:
          Sep{}
        case False{}:
          Other{c}

def kind(+c: Char) -> Sort:
  kind.go(U32.is_eq(Char.to_u32(c), 34), U32.is_eq(Char.to_u32(c), 44), c)

def code_of(k: Sort) -> U32:
  match k:
    case Other{c}:
      Char.to_u32(c)
    case Quote{}:
      34
    case Sep{}:
      44

def double(+c: Char, rest: String) -> String:
  SCon{c, SCon{c, rest}}
