# bend-emit

**Turn a pure Bend core into a typed ES module.**

Write your pure functions and proofs in [Bend](https://github.com/bendlang/bend),
then call the generated functions from TypeScript. bend-emit generates named
exports and TypeScript declarations, and applies conservative runtime
optimizations to Bend's JavaScript output.

## Quick Start

Install **Bend 2.0.34** and **Bun**, with both `bend` and `bun` on PATH.
The commands below also require Node.js and npm for `npx`.
Installing this npm package does not install Bend or Bun.

Save this as `core.bend`:

```bend
import Base

def add(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)
```

Build it:

```sh
npx --yes --package bend-emit@0.3.0 -- bend-emit core.bend dist
```

Then import the generated module:

```ts
import { add } from "./dist/core.mjs";

add(2n, 3n); // 5n; the generated signature uses bigint
```

For a project-local installation:

```sh
npm install --save-dev --save-exact bend-emit@0.3.0
npx bend-emit core.bend dist
```

Bun users can install and run the same package:

```sh
bun add --dev --exact bend-emit@0.3.0
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
with declarations derived from the Bend source.

**The generated JavaScript is not independently proved.** Its behavior also
depends on Bend's backend and bend-emit's transformations. Tests compare
transformed output with Bend's output; they do not replace a proof of the
compiler or this tool.

For a worked example, see
[bend-schema](https://github.com/nohzafk/bend-schema), which builds a typed
JavaScript interface to a schema checker written in Bend.

## How It Works

bend-emit runs `bend <core.bend> -o <out>.mjs`, then processes the emitted
module and reads the source's data declarations and definition headers.

Bend exports a default object. bend-emit adds named exports for its definitions
while retaining the default export's interface. It checks that the source
names and compiled export names agree before writing the output.

Supported types follow Bend's runtime representation:

| Bend | JavaScript / TypeScript |
| --- | --- |
| `Nat` | `bigint` |
| `U32` | `number` |
| `Bool` | `boolean` |
| `String` | `string` |
| `Char` | `string` containing one code point |

The tool refuses an unsupported type in a signature it needs to declare,
instead of guessing its representation.

### Runtime Transformations

The generated module is not byte-for-byte identical to Bend's output.
bend-emit applies these transformations:

- **Constructor tags:** remove imported-module prefixes so tags match the
  bare names used by the generated declarations. Unresolved prefixed tags
  cause a build failure.
- **Recursive list construction:** turn eligible self-recursion in a
  constructor's last field into a loop and a reconstruction stack.
  Other recursive shapes remain unchanged and produce a
  `still recursive: <name> (<why>)` diagnostic.
- **Zero-field constructors:** reuse singleton values rather than allocating
  a new object for each occurrence.
- **String traversal:** replace eligible string-head/string-tail traversal
  with an index into the original string. Code-point traversal still handles
  surrogate pairs. Uses outside the recognized shapes remain unchanged and
  produce a `string still sliced: ...` diagnostic.

These passes recognize specific output shapes. They do not guarantee that
all recursion becomes stack-safe or that every core uses less memory.
Review the diagnostics and measure your own workload.

### Undeclared Definitions

Some definitions have no generated TypeScript signature:

- Definitions returning `IO(...)`.
- Definitions with template parameters such as `~f`.
- Definitions returning `Data` or `Type`, using computed types, or carrying
  erased parameters.

Where Bend includes such a definition in its emitted module, bend-emit does
not remove it. The absence of a declaration is not a supported typed API.
Template definitions are not exported by Bend's ES-module target.

## Toolchain Requirements

The build tool requires Bun and **exactly Bend 2.0.34**, the version recorded
in `BEND_VERSION`. Another Bend version is rejected before compilation.

The emitter reads and transforms compiler output, so a different compiler
version could change the shapes it relies on. Pin bend-emit and use the Bend
version required by that release.

Since 0.2.0, output files use `.mjs` and `.d.mts`, not `.js` and `.d.ts`.
Projects updating from 0.1.0 must rebuild and update their import paths.

## Development

From a checkout, install the development dependencies and run the gate:

```sh
bun install --frozen-lockfile
sh test.sh
```

The gate builds fixture cores, checks runtime values and declarations,
compares optimized output with Bend's output, and tests refusal paths.
It also typechecks valid and invalid TypeScript calls and loads a generated
module with Node in both CommonJS and ESM packages.

## License

MIT. See [LICENSE](LICENSE).
