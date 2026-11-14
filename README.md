# bend-emit

**Turn a pure Bend core into a typed ES module.**

Write your pure functions and proofs in [Bend](https://github.com/bendlang/bend),
then call the generated functions from TypeScript. bend-emit generates named
exports and TypeScript declarations, and applies conservative runtime
optimizations to Bend's JavaScript output.

## Quick Start

Install **Bun**, with `bun` on PATH. bend-emit carries the source of
**Bend 2.0.40** and runs it in-process, so `bend` itself need not be
installed. The commands below also require Node.js and npm for `npx`.
Installing this npm package does not install Bun.

Save this as `core.bend`:

```bend
import Base

def add(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)
```

Build it:

```sh
npx --yes --package bend-emit@0.5.1 -- bend-emit core.bend dist
```

Then import the generated module:

```ts
import { add } from "./dist/core.mjs";

add(2, 3); // 5; the generated signature uses number
```

For a project-local installation:

```sh
npm install --save-dev --save-exact bend-emit@0.5.1
npx bend-emit core.bend dist
```

Bun users can install and run the same package:

```sh
bun add --dev --exact bend-emit@0.5.1
bunx bend-emit core.bend dist
```

## Generated Files

```sh
bend-emit <core.bend> <outdir>
```

For `core.bend`, the command writes:

- `core.mjs`: an ES module with named exports and a default export.
- `core.d.mts`: declarations for the supported public definitions and data types.

The `.mjs` extension makes the module load as ESM in both CommonJS and ESM
packages. The matching `.d.mts` extension lets TypeScript resolve its types.

Commit or distribute both files with your application or library. Consumers
of these generated files do not need Bend, Bun, or bend-emit at runtime.
They need a JavaScript runtime with ES-module support.

## Why Bend

Bend lets you state laws about pure functions and prove them for all inputs
covered by those laws. This is useful for parsers, validators, codecs, and
other pure logic with precise requirements.

bend-emit uses Bend's JavaScript backend rather than a second implementation
of your core. Your TypeScript application calls the generated functions,
with declarations derived from the checked Bend core.

**The generated JavaScript is not independently proved.** Its behavior also
depends on Bend's backend and bend-emit's transformations. Tests compare
transformed output with Bend's output; they do not replace a proof of the
compiler or this tool.

For a worked example, see
[bend-schema](https://github.com/nohzafk/bend-schema), which builds a typed
JavaScript interface to a schema checker written in Bend.

## How It Works

bend-emit loads and checks the core with Bend's own source, as
`bend <core.bend> -o <out>.mjs` does, and takes the JavaScript from Bend's
own compiler in the same process: the text that command writes. No Bend
source is parsed by bend-emit.

The declarations come from the checked core: each definition's type and each
data type's constructors, as Bend's checker holds them. Imports are Bend's to
resolve: a relative import, and a hub package imported as `0x<hash>/...` or
`<name>@<version>/...`, fetched into `BEND_LIB` (default `~/.bend/lib`).
A type alias such as `def Var() -> Data` is resolved to the type it names.
An imported type is named by its import alias, `G_Err` for `Err` in
`import ./g.bend as G`; a file reached through two imports is declared once,
and its other names are aliases of the first.

Bend exports a default object. bend-emit adds named exports for its definitions
while retaining the default export's interface. It checks that the declared
names and compiled export names agree before writing the output.

Supported types follow Bend's runtime representation:

| Bend | JavaScript / TypeScript |
| --- | --- |
| `Nat` | `number`: a whole number from 0 to 2^53 |
| `U32` | `number` |
| `F32` | `number`, rounded to single precision |
| `Bool` | `boolean` |
| `String` | `string` |
| `Char` | `string` containing one code point |
| `Map<A>` | `BendMap<A>`: a tagged tree with `MTip`, `MLeaf`, and `MNode` |
| `A & B`, `Sigma<A, _ => B>` | `BendPair<A, B>`: `{ $: "Tuple", fst, snd }` |
| `Cmp` | `BendCmp`: `LT`, `EQ` or `GT` |
| `Array<A>` | `BendArray<A>`: a JavaScript array `A[]` |
| `Word(n)` | `BendWord`: `n` cells `{ $: "WCon", head: boolean, tail }`, low bit first, ending in `{ $: "WNil" }` |
| a type a law declares and nothing defines (`Chan(A)`, `File`, `Socket`, ...) | `BendHandle<"Chan", [A]>`, `BendHandle<"File">`: a branded value the host can only pass back |
| a proof, `{a == b : T}` | `null` |
| `@-R: Type -> ...`, a function with an erased type argument | a generic function, `<R>(x: ...) => ...` |

The generated declaration preamble defines `BendList`, `BendMap`, `BendMaybe`, `BendResult`, `BendEither`, `BendPair`, `BendCmp`, `BendArray`, `BendWord` and `BendHandle` using the runtime's tagged constructors. A `BendMap` is not a native JavaScript `Map`; its `MNode.pos` field is a `number`, like Bend's `Nat` representation. The map's structural invariants are those of the Bend `Map` implementation; bend-emit only describes its runtime shape.

The types say less than Bend does, and a host must keep the rest:

- An `Array`'s length is a power of two (`Array.new`'s depth `d` makes `2^d`
  cells). A def an array is passed to owns it, and may change it in place:
  `Array.set` returns the array it was given. Pass a copy to keep the original.
- `Word(n)` is one TypeScript type for every `n`; the def expects exactly `n`
  cells.
- A type parameter that is a value, an index (`Vec<-n: Nat>`), is not in the
  runtime's value, and the TypeScript type drops it: `Vec<3n>` is `Vec`.
- A proof the host passes as `null` asserts its equation; nothing checks it.
- Any other erased argument of a function (`@-n: Nat -> ...`) is not passed,
  and is left out of its TypeScript type.

### Runtime Transformations

The generated module is not byte-for-byte identical to Bend's output.
bend-emit rewrites a few shapes of Bend's JavaScript that cost stack or
allocation at scale:

- **Direct calls:** a call through Bend's `$$f` entry is written back as a
  direct call, so the passes below see a def's self-calls.
- **Lazy selectors:** a call to a def that only picks one of two parameters
  by a `Bool` runs only the chosen argument.
- **Lazy arguments:** a call whose result only some paths read runs on those
  paths only: an argument of a helper def that branches, or the right side
  of `Bool.or` and `Bool.and`. A search written with such a helper stops at
  its first hit.
- **Recursion to loops:** the self-call evaluated last in a `return` becomes
  a loop step, with the rest of the expression kept on a heap stack.
- **Native string comparison:** Base's `String.order.go` becomes a native
  loop that returns the same `Cmp`.
- **String walks by index:** a string that a def only peels at its head is
  carried as the same string and an index, not a new tail per character.
- **Shared nullary constructors:** a constructor with no fields is one shared
  value, so two such values are `===`.

Each pass matches the exact text Bend 2.0.40 writes. Where the shape is not
there, the code stays as Bend wrote it, and the command prints a diagnostic
(`still eager:`, `still recursive:`, `string still sliced:`,
`not made native:`, `call kept through an entry:`). The passes do not make every recursion
stack-safe or every core smaller. Review the diagnostics and measure your own
workload.

### Laws and Facts Files

A file that holds laws and lemmas, such as a `LAWS.bend` with reference
definitions beside its laws, can be built directly. bend-emit builds a copy of
the file, and of every `.bend` file it imports, without:

- every `law`;
- every def whose header line contains `==` (a lemma), and every def named
  like a law (its proof);
- every def or type that names a skipped one, directly or through an import
  alias such as `KF.lemma`;
- every `import bend-mathlib...` line.

What remains is emitted as usual. A lemma whose `==` is not on the def's
header line is not recognized. A file with nothing to skip is built from its
own path, exactly as before.

In such a build, a def with no TypeScript encoding (for example one whose type
is a Base type such as `Image`) stays in the `.mjs` and is left out of the
`.d.mts`, with one warning line naming it. In an ordinary core it is still an
error.

### Undeclared Definitions

Some definitions have no generated TypeScript signature:

- Definitions returning `IO(...)`.
- Definitions with template parameters such as `~f`.
- Definitions returning `Data` or `Type`, using computed types, or carrying
  erased parameters.

Where Bend includes such a definition in its emitted module, bend-emit does
not remove it. The absence of a declaration is not a supported typed API.
Template definitions are not exported by Bend's ES-module target.

## Tested on BendHub

With Bend 2.0.40, bend-emit builds all 115 pure BendHub packages that Bend
itself compiles, and every generated `.d.mts` typechecks under `strict`.
Across those packages, 17,656 calls of their exported defs gave the same
result before and after bend-emit's passes. A core that searches a list
through a helper def went from 29 s in Bend's own JavaScript to 0.16 s. On
[bend-csv](https://github.com/nohzafk/bend-csv)'s benchmark, a 10 MB parse
takes 234 ms, against 318 ms for Deno's `@std/csv`.

How bend-emit reads the core, how each type is encoded, what each pass
rewrites, and how all this is checked: see the
[technical reference](docs/techniques.md).

## Toolchain Requirements

The build tool requires Bun. It runs **exactly Bend 2.0.40**, the version
recorded in `BEND_VERSION`, from the Bend source the package carries in
`bend2/`. A `bend2/` of another version is rejected before compilation.

The emitter transforms compiler output, so a different compiler version could
change the shapes it relies on. Each bend-emit release carries the Bend it was
tested with.

## Development

From a checkout, install the development dependencies and run the gate:

```sh
bun install --frozen-lockfile
sh test.sh
```

The gate first puts Bend's source in `bend2/` (`sh tools/bend-src`, which
`npm pack` also runs, with `--tag`). It takes the source from `$BEND_SRC`,
else a Bend checkout at `~/projects/bend` at tag `v<version>`, else
`~/projects/.toolchains/bend-src-<version>`. From a checkout it reads the files
of the tag; `--tag` refuses a source tree that is not a checkout. `bend2/` is
not committed. The gate
also checks its fixture cores with the `bend` command of that version.

The gate builds fixture cores, checks runtime values and declarations,
compares optimized output with Bend's output, and tests refusal paths.
It also typechecks valid and invalid TypeScript calls and loads a generated
module with Node in both CommonJS and ESM packages.

## License

MIT. See [LICENSE](LICENSE).

The npm package also contains Bend's source in `bend2/`, under the Apache
License 2.0. See `bend2/LICENSE`.
