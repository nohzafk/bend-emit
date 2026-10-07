import Base

# Base Map on the host boundary, including a recursive mapped value.
type Value is Data:
  Leaf{n: Nat}
  Branch{children: Map<&2, Value>}

def empty() -> Map<&2, Nat>:
  Map.new(&2, Nat)

def insert(m: Map<&2, Nat>, k: String, n: Nat) -> Map<&2, Nat>:
  Map.set(&2, Nat, m, k, n)

def lookup(m: Map<&2, Nat>, k: String, d: Nat) -> Nat:
  Pair.snd(Map<&2, Nat>, Nat, Map.get(Nat, d, m, k))

def value_identity(v: Value) -> Value:
  v
