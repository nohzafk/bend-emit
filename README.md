# bend-emit

**Turn a pure Bend core into an ordinary typed ES module.**

Write your pure functions in Bend; call them from TypeScript like any other
typed import.

```bend
import Base

def add(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)
```

```ts
import { add } from "./dist/core.js";  // add(a: bigint, b: bigint): bigint
add(2n, 3n);                           // 5n
```

```sh
bend-emit <core.bend> <outdir>
```

writes `<outdir>/<name>.js` and `<outdir>/<name>.d.ts`, so a host can write
`import { slots } from "./dist/core.js"` and tsc knows every def's type.

## Why it exists

Bend 2.0.27 has no library target. `bend x.bend -o x.js` builds a program: it
runs `main` and exports nothing. Only the page bundler compiles an imported
`.bend` file into a module, and what it emits is bend's own loader shape,
`export default { name: fn, ... }`, which a page entry cannot re-export: an HTML
entry keeps no exports.

So this writes a one-line page entry whose script hands the module to a hook,
`$bend_emit_set(Core)`, runs the page bundler, and wraps the chunk it gets back --
the hook's definition before it, the named exports after it. The hook is a free
name, which a minifier keeps, and no global is written.

The types are derived from the `.bend` source, never written by hand: the
`type ... is Data:` blocks and the `def` headers are read, and each Bend type
maps to the runtime's own encoding. A Bend type this tool does not know is
refused, naming the def -- a guess would be a hand-written type again. The def
names read from the source must be exactly the names the compiled module
exports, or nothing is written.

## What it leaves undeclared

A def the module keeps but the `.d.ts` does not declare:

- one returning `IO(...)`: an effect, whose type only the host can vouch for
- one with a template parameter (`~f`): the bundler does not export them
- one returning `Data` or `Type`, or over a type one computes (a type computed
  by a def, like `Meaning(s)`, is not a TypeScript type), or with an erased
  parameter

They stay in the module and still run; only their signature is missing.

## Requirements

`bend` on PATH -- the page bundler is the only compiler path that emits a
module -- and bun to run this tool.

## Develop

```sh
sh test.sh
```

checks five fixture cores, builds each into a module, runs the tests (the
`.d.ts` text, the refusals, the values at run time), and typechecks a host
written against the generated types.
