import Base

# Defs named like top-level functions of bend's own runtime: the module must
# still load, and each def is exported under its own name.
def run_lib(n: Nat) -> Nat:
  n

def run_loop(n: Nat) -> Nat:
  (n + 1n : Nat)

def nat_host(b: Bool) -> Bool:
  b

def cmp_new(s: String) -> String:
  s

# A name a module cannot bind: reached through the default export only.
def class(n: Nat) -> Nat:
  n

# Text that spells the names bend-emit binds its exports to: data, not a
# collision.
def message() -> String:
  "be$default be$0"

# The name the declaration file gives its default object, when nothing else
# uses it.
def core(n: Nat) -> Nat:
  n
