import Base

type Item is Data:
  Item{id: Nat, weight: Nat}

def heavier(a: Item, b: Item) -> Bool:
  match a b:
    case Item{ia, wa} Item{ib, wb}:
      Nat.is_eq(wa, wb)
