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
import { add } from "./dist/core.mjs";  // add(a: bigint, b: bigint): bigint
add(2n, 3n);                            // 5n
```

```sh
bend-emit <core.bend> <outdir>
```

writes `<outdir>/<name>.mjs` and `<outdir>/<name>.d.mts`, so a host can write
`import { slots } from "./dist/core.mjs"` and tsc knows every def's type.

The module is `.mjs` and the declaration `.d.mts` because that is the pair
TypeScript resolves. A `.d.ts` is the declaration for a `.js` module: tsc
resolving a `.mjs` tries `core.mts`, then `core.d.mts`, and stops (measured
with `--traceResolution`) — it never looks for `core.d.ts`. And the module has
to be `.mjs` in the first place, because Node decides a `.js` file's module
system from the nearest `package.json` `"type"`, so the same file loads under
`"type": "module"` and dies under `"type": "commonjs"` with
`SyntaxError: Unexpected token 'export'`. Naming it `.mjs` also matches what
bend itself emits (`bend x.bend -o x.mjs`). The gate loads a built module with
node under both package modes, which is the check whose absence let the old
`.js` name through.

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
JS to import" -- and it is the command bend-emit runs.

What bend writes is `export default { name: fn, ... }`, and nothing else: bend
emits no named exports. A host says `import { name } from "./dist/core.mjs"`, and
the `.d.mts` declares those names, so bend-emit binds that object to a local name
and re-exports each def from it. The default export stays bend's own object,
unchanged. The module is otherwise bend's, byte for byte.

The types are derived from the `.bend` source, never written by hand: the
`type ... is Data:` blocks and the `def` headers are read, and each Bend type
maps to the runtime's own encoding: `Nat` is `bigint`, `U32` is `number`,
`Bool` is `boolean`, `String` is `string`, and `Char` is a `string` of one code
point (the runtime makes one with `String.fromCodePoint`). A type body may hold
comments and blank lines, as bend allows. A Bend type this tool does not know is
refused, naming the def -- a guess would be a hand-written type again. The def
names read from the source must be exactly the names the compiled module
exports, or nothing is written.

Two changes are made to what bend writes.

Imported constructor tags are put back to bare names. bend tags a constructor
of an imported module with that module's path (`"generics.TooBig"`), and the
`.d.mts` and every host that builds values by hand (bend-schema's codec) speak bare names. A
module whose tags still carry a path is refused, not written.

## What it leaves undeclared

A def the module keeps but the `.d.mts` does not declare:

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
bunx bend-emit core.bend dist      # writes dist/core.mjs and dist/core.d.mts
```

Commit the generated `dist/` and import from it; your package then needs
neither Bend nor bend-emit at run time.

**Breaking change.** Up to 0.1.0 the tool wrote `dist/core.js` and
`dist/core.d.ts`. From 0.2.0 it writes `dist/core.mjs` and `dist/core.d.mts`:
an existing `import { slots } from "./dist/core.js"` becomes
`"./dist/core.mjs"`, the `dist/core.d.ts` is gone (nothing resolved it), and
rebuild to get the `.mjs` and the `.d.mts`. The types a host names do not
change — only the module path does.

## Requirements

`bend` on PATH at exactly the version in `BEND_VERSION` (2.0.34), and bun to
run this tool. Another version is refused before anything is compiled: the
module is bend's own output, and this tool rewrites its tags and reads its
exports, so a compiler it was never tested against could change either
silently. A consumer pinned to an older bend pins an older bend-emit with it.

## Develop

```sh
sh test.sh
```

checks six fixture cores, builds each into a module, runs the tests (the
`.d.mts` text, the refusals, the values at run time), typechecks a host
written against the generated types, checks that a host's *wrong* call to a
`.mjs` module is refused with TS2345 through the `.d.mts` beside it, and loads
a built module with node under both `"type": "commonjs"` and `"type": "module"`.
