# bend-emit

**Turn a pure Bend core into an ordinary typed ES module.**

Write your pure functions in [Bend](https://github.com/bendlang/bend); call
them from TypeScript like any other typed import.

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

## Why write it in Bend

Tests check the cases you thought of. [Bend](https://github.com/bendlang/bend)
lets you state a law about a function -- "decoding an encoded value gives it
back", "this check passes exactly when the value conforms" -- and prove it for
every input; the proof is checked when the file is checked. Pure logic is where
that pays off: parsers, validators, codecs, pricing and permission rules.

bend-emit is the bridge that makes the proved code usable. You keep the core
in Bend with its proofs, and your TypeScript application imports the very
functions the proofs are about, with their types -- not a reimplementation
that could drift from them.

For a worked example, see
[bend-schema](https://github.com/nohzafk/bend-schema): a schema library whose
checker is written and proved in Bend and shipped to TypeScript with
bend-emit. It also lets one schema be reused on both sides: define it in
TypeScript, generate its Bend form, use it in your own proved Bend functions,
and call those back from TypeScript.

## How it works

The JavaScript is bend's own. `bend <core.bend> -o <out>.mjs` is bend's
ES-module target -- `bend --help` calls it "an ES module of its non-IO defs, for
JS to import" -- and it is the command bend-emit runs. Bend was not always able
to do this: before 2.0.32 `bend x.bend -o x.js` built a *program*, one that ran
`main` and exported nothing, so a module could only be had by bundling a page
whose entry handed it to a hook. That entry, the hook, and the wrapper that put
the exports back are gone.

What bend writes is `export default { name: fn, ... }`, and nothing else: bend
emits no named exports. A host says `import { name } from "./dist/core.js"`, and
the `.d.ts` declares those names, so bend-emit binds that object to a local name
and re-exports each def from it. The default export stays bend's own object,
unchanged. The module is otherwise bend's, byte for byte.

The types are derived from the `.bend` source, never written by hand: the
`type ... is Data:` blocks and the `def` headers are read, and each Bend type
maps to the runtime's own encoding. A Bend type this tool does not know is
refused, naming the def -- a guess would be a hand-written type again. The def
names read from the source must be exactly the names the compiled module
exports, or nothing is written.

Two changes are made to what bend writes.

Imported constructor tags are put back to bare names. Since bend 2.0.28 bend
tags a constructor of an imported module with that module's path
(`"generics.TooBig"`), where 2.0.27 wrote the bare name, and the `.d.ts` and
every host that builds values by hand (bend-schema's codec) speak bare names. A
module whose tags still carry a path is refused, not written.

Base's `String.reverse` (and any def with the same loop) compiles to
`acc = c + acc` per code point, and in JavaScriptCore every `+` is a rope node:
a reversed string reaches the host as a chain of one-character nodes, all alive
while it is. The loop is matched by its whole structure and replaced by
`Array.from(s).reverse().join("") + acc`, the same function over code points,
returning a flat string. In csv-lib, whose fields are built backwards and
reversed, this is the difference at 10 MB of CSV between 1.2 s and 1.23 GB peak
and 1.05 s and 0.83 GB (this Mac, `bun scale.ts` under `/usr/bin/time -l`). The
tests check both that no such loop is left in a built module -- a bend release
that changes its shape stops the lowering, and fails there -- and that the
replacement answers what the loop did.

## What it leaves undeclared

A def the module keeps but the `.d.ts` does not declare:

- one returning `IO(...)`: an effect, whose type only the host can vouch for
- one with a template parameter (`~f`): bend's `.mjs` target does not export them
- one returning `Data` or `Type`, or over a type one computes (a type computed
  by a def, like `Meaning(s)`, is not a TypeScript type), or with an erased
  parameter

They stay in the module and still run; only their signature is missing.

## Install

Not on npm; install from GitHub as a dev dependency (it is a build tool):

```sh
bun add -d github:nohzafk/bend-emit
bunx bend-emit core.bend dist      # writes dist/core.js and dist/core.d.ts
```

Commit the generated `dist/` and import from it; your package then needs
neither Bend nor bend-emit at run time.

## Requirements

`bend` on PATH -- 2.0.32 or later, whose `-o <file>.mjs` target emits a module
-- and bun to run this tool.

## Develop

```sh
sh test.sh
```

checks five fixture cores, builds each into a module, runs the tests (the
`.d.ts` text, the refusals, the values at run time), and typechecks a host
written against the generated types.
