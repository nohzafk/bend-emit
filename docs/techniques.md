# bend-emit Technical Reference

bend-emit turns a pure Bend 2 core into an ES module (`.mjs`) and its
TypeScript declarations (`.d.mts`). The JavaScript is Bend's own: its
ES-module target, made in-process from Bend's source. bend-emit adds named
exports, writes declarations from the checked core, and rewrites a few
shapes of Bend's output that cost stack or allocation at scale.

This document covers how it does that and how it is checked. The
[README](../README.md) covers how to use it.

---

## 1. Architecture: Bend's Own Front End and Back End

bend-emit does not parse Bend. [`src/book.ts`](../src/book.ts) loads the
core with Bend's own loader and checker (`book_load`, `book_valid`), from
the Bend source in `bend2/`, and reads everything else from the checked
`Book`:

- **The JavaScript** is `comp.js_lib(book, true)`: the text that
  `bend <core.bend> -o <out>.mjs` writes, made in the same process. For all
  115 BendHub packages Bend 2.0.40 compiles, the program it produces is
  identical to the CLI's (section 7).
- **The exports** follow `js_lib`'s own rule: a def that is filled, is not
  Base's, has no template parameter, and whose type is not `IO`. The defs of
  imported files are left out; their names carry their file's namespace
  (`generics:first_big`).
- **The types** are the checked terms. Each def's type and each data type's
  constructors are normalized by Bend (`term_wnf`) and mapped to the
  runtime's encoding (section 3).

This has three consequences:

1. **No second reading of the language.** Multi-line headers, dotted names,
   hub imports, type aliases (`def Var() -> Data`), and computed types are
   read by Bend, as Bend reads them. A core Bend accepts is a core bend-emit
   reads.
2. **Erasure comes from the checker.** A parameter whose quantity is `0`
   (`-A`), a value index (`Vec<-n: Nat>`), and a proof are known from the
   term, not guessed from the text.
3. **The runtime is unchanged.** bend-emit uses Bend's JavaScript runtime and
   value shapes. The declarations describe those shapes; they do not invent
   new ones.

The one thing the `Book` does not keep is the alias a file gives an import
(`import ./generics.bend as G`). bend-emit uses that alias to name an imported
type in TypeScript (`G_Err`), so it reads the `import` lines at the head of
each file (`importsOf`, `prefixes`).

---

## 2. Build Steps

`build(core, outDir)` in [`src/emit.ts`](../src/emit.ts):

1. **Laws files** ([`src/laws.ts`](../src/laws.ts)). A file that holds laws
   or lemmas is built from a copy without them, and without its
   `bend-mathlib` imports. A file with nothing to skip is built from its own
   path.
2. **Load and check** (`load`): `book_load` and `book_valid`, as the CLI
   does. A failed check stops the build with Bend's own error text. A
   remaining `TODO` also stops the build.
3. **Exports** (`exported`): the defs `js_lib` exports, as in section 1.
4. **JavaScript** (`javascript`): `js_lib(book, true)`.
5. **Declarations** (`declarations`): every data type the core reaches, and
   each exported def whose type has an encoding (section 3).
6. **Runtime passes**, in this order: `entries`, `intrinsics`, `select`,
   `loops`, `strpeel`, `classes` (section 4).
7. **Named exports** (`exportsOf`): Bend's `export default { ... }` is bound
   to `be$default`, and each def is re-exported from it under its own name.
   Bend never writes a name that starts with `be$`, so these names cannot
   collide with Bend's runtime or with a def.
8. **Export check.** The `.mjs` is written and imported. Its exports must be
   exactly the defs read from the `Book`, or the `.mjs` is removed and the
   build fails. The `.d.mts` is written only after this check.

The command prints a diagnostic line for each shape a pass left as Bend
wrote it (`still recursive:`, `string still sliced:`, `not made native:`,
`call kept through an entry:`), and, for a laws file, the defs left out of
the `.d.mts`.

---

## 3. Types and the Host Boundary

`tsType` maps a normalized Bend type to TypeScript:

| Bend | TypeScript | Runtime value |
| :--- | :--- | :--- |
| `Nat`, `U32`, `F32` | `number` | JS number; `F32` rounded to single precision |
| `Bool` | `boolean` | |
| `String`, `Char` | `string` | a `Char` is one code point (`String.fromCodePoint`) |
| `Unit` | `BendUnit` | `{ $: "Unit" }` |
| `List`, `Maybe`, `Result`, `Either`, `Map` | `BendList<T>`, ... | Base's tagged constructors |
| `A & B` (`Sigma` whose second type does not depend on the first) | `BendPair<A, B>` | `{ $: "Tuple", fst, snd }` |
| `Cmp` | `BendCmp` | `LT`, `EQ`, `GT` |
| `Array<T>` | `BendArray<T>` = `T[]` | a JS array, power-of-two length, changed in place |
| `Word(n)`, for any `n` | `BendWord` | `n` `WCon` cells, low bit first |
| a type a `law` declares and nothing defines (`File`, `Chan(A)`) | `BendHandle<"Chan", [A]>` | an opaque value the host can only pass back |
| a proof `{a == b : T}` | `null` | the runtime holds no evidence |
| `A -> B` | `((x: A) => B)` | a JS function of one argument |
| `@-R: Type -> ...` | `(<R>(x: ...) => ...)` | an erased type argument is not passed |
| a data type of the core or an import | its name, prefixed by the import alias | `{ $: "<Ctor>", <field>: ... }` |

### What the Declaration Leaves Out

The encoding fails in one of two ways (`NoEncoding`):

- **The type depends on a value**: a variable that is not a type parameter, or
  a type a def computes (`Pick(b)`). The def stays in the module and is left
  out of the `.d.mts`. A def with an erased parameter, and a def that returns
  `IO`, are also left out.
- **The type has no encoding**: for example, a type with constructors
  removed, or a value of every type. In an ordinary core this stops the
  build, and the error names the def. In a laws file, the def is left out of
  the `.d.mts` with a warning.

### Value Indexes and Erased Fields

A data type's parameters are classified by their kind (`kindsOf`):

- **A type** (`Type`) becomes a TypeScript type parameter.
- **An index**, which is a value such as a `Nat`, becomes nothing. The
  runtime's value does not carry it, so `Vec<3n>` is `Vec`.
- **Any other kind**, such as `Type -> Type`, stops the build.

An erased constructor field (`-f`) is not in the runtime's object, so it is
not declared. It is still opened, because a later field's type can name it.

### Functions Returned by a Def

A def can return a function. Bend's wrapper for an export, `run_lib(fn, n)`,
converts what it returns after `n` arguments as the final value. If a def's
body returns an existing function instead of writing `x => ...`, `n` is
smaller than the number of arguments in its type. A String result returned
too early would then be converted as a closure. bend-emit reads each `n` from
Bend's `export default` block (`arities`). It declares a returned function
only when `n` covers every argument of the type. Otherwise the build stops
with "returns a function bend's module returns unfinished".

### Names

- **Imported types.** An imported data type is named by its import alias:
  `G_Err`, and `A_B_T` through two imports. The walk is breadth first, so a
  file reached two ways is declared under its shortest prefix, and the other
  names become aliases of it.
- **Dotted names.** A dotted Bend name such as `Parse.Cur` is written
  `Parse_Cur`. Two types that come out with the same name stop the build.
- **Refused type names.** A type named like a preamble type (`BendList`, ...)
  or a TypeScript keyword (`class`, `string`) stops the build.
- **Renamed type parameters.** A type parameter that TypeScript cannot use
  is written `be$<name>`. A generated generic gets a fresh name that is not
  already in scope, so it cannot shadow an enclosing parameter.
- **Defs that cannot be a binding.** A def whose name cannot be bound in a
  module (a reserved word, or a name with `.`) is reached through the default
  export only.

---

## 4. Runtime Passes

Each pass reads the text Bend 2.0.40 writes. A pass matches exact shapes.
When the shape is not there, the pass leaves the code as Bend wrote it and
reports it. A Bend version that changes these shapes makes the passes do
nothing, not do something wrong. The gate's fixtures hold each shape, so the
gate fails in that case.

### `entries`: Direct Calls

Bend 2.0.40 writes a call that is not in tail position through an entry
`$$f`, defined after every function (`const $$f = $f;`, or a wrapper that
runs the jump loop). Each such call is written back as a call of the def
itself, `($f(args))` or `run_loop($f(args))`, and the entry is removed when
nothing uses it. The passes below find a def's self-calls by its own name, so
they need this.

### `intrinsics`: Native String Comparison

Every `String.eq`, `String.order` and `String.is_*` in Base calls
`String.order.go`. Bend's version slices both strings and allocates a `Cmp`
at every equal character. bend-emit replaces it with a native loop that
returns the same `Cmp`: by `Char` code, then the shorter string first. Two
non-surrogate UTF-16 units are compared directly; anything else goes through
the runtime's `char_len` and `char_code`. This is done only when the def's
text is exactly what Bend 2.0.40 writes. On bend-schema's wide-object check,
Bend's version was 9x slower.

### `select`: Lazy Selectors

Bend evaluates call arguments eagerly, so `pick(c, f(x), g(y))` runs both
calls. A selector is a def whose emitted body is exactly
`if (b) { return p; } else { return q; }` over its own parameters. The pass
finds selectors by shape, in imported files too.

- **A call that is a whole `return`** becomes
  `if (b) { return X; } else { return Y; }`. A self-call stays the last thing
  its branch returns, where `loops` can use it.
- **A call anywhere else** becomes `(b ? X : Y)`, unless `X` or `Y` calls the
  enclosing def. Such a call stays eager.

### `loops`: Recursion to Loops

Bend already turns a tail self-call into `for (;;)`. Any other self-call in a
`return` costs one JavaScript frame per step. For the self-call evaluated last
(the "hole"):

1. What comes before the hole is evaluated first, in the same order.
2. What comes after it is pushed on a per-call stack as a closure.
3. The parameters are rebound to the hole's arguments, and the loop
   continues.
4. Every other `return` folds the stack, innermost first.

This covers `Con{head: f(x), tail: f(t)}`, `and(f(h), f(t))`, `n + f(t)`, and
a self-call bound in a `const` just before the `return`. It works only from
the shape of the text and does not use names.

These stay as Bend wrote them, with a `still recursive:` diagnostic: a def
with no hole, a self-call under `||`, `&&` or `?:`, and a def that uses its
own name as a value. Self-calls other than the hole stay real calls.

### `strpeel`: String Walks by Index

Bend matches a string as `S.slice(0, char_len(S))` (head) and
`S.slice(char_len(S))` (tail). That is a new string per character. When a def
only tests `S === ""`, reads the head, and hands the tail to its next step or
to a def that does only the same, the tail is carried as an index instead:

- The string stays the same object.
- A trailing parameter `be$i<P>`, with default `0`, holds the position.
  Callers outside are unchanged.

Two helpers, `be$head` and `be$next`, read a non-surrogate unit as one `Char`
directly; a surrogate goes through `char_len`. Any other use of the parameter
leaves the whole parameter as Bend wrote it, with a `string still sliced:`
diagnostic.

### `classes`: Shared Nullary Constructors

Each constructor literal `{$: "T", a: x}` becomes `new $T_T_a(x)` on a class
with one field order. A constructor with no fields becomes one shared
instance. The classes alone measured neutral; sharing nullary values took
about 20% off peak memory on a token-heavy core. As a result, two nullary
values of the same constructor are the same object (`===`).

---

## 5. The Pinned Bend

bend-emit runs exactly the Bend version in `BEND_VERSION` (2.0.40). The passes
read the shapes of that version's output, and the declarations rely on its
runtime encodings, so a different compiler could change either without a
warning.

- **`bend2/`** holds Bend's source at that version: `bend.ts`, `comp.ts`,
  `base.bend` and `effs/`, under Apache-2.0. It is gitignored. The npm package
  carries it.
- **`tools/bend-src`** fills `bend2/`. From a Bend checkout it reads the files
  of tag `v<version>` with `git archive`, so uncommitted edits cannot get in.
  `prepack` runs it with `--tag`, which accepts only a tagged checkout.
- **`checkSource`** refuses a `bend2/` whose `VERSION` is not `BEND_VERSION`,
  before anything is loaded.

The `bend` command is not needed to build. The gate still uses it, to check
the fixture cores.

---

## 6. Limits

- **The JavaScript is not proved.** Bend's backend and these passes are
  tested, not verified.
- **The passes match exact shapes.** They do not make every recursion
  stack-safe or every core smaller. Read the diagnostics, and measure your
  workload.
- **The types say less than Bend does.** An `Array`'s length, a `Word(n)`'s
  width, an index, and a proof passed as `null` are not checked at the
  boundary. The README lists what a host must keep.

---

## 7. Verification

### The Gate

`sh test.sh` builds each fixture core and checks:

- the `.d.mts` text, and the refusal of types with no encoding;
- the values at run time, including each pass's shapes, against Bend's
  unmodified output;
- that the source and a host written against the generated types typecheck,
  and that a set of wrong calls fails to typecheck;
- that Node loads a built module in both CommonJS and ESM packages.

### BendHub Sweep (Bend 2.0.40)

The 142 pure packages cached from BendHub, each built from its entry core:

| Result | Packages |
| :--- | ---: |
| No entry core | 7 |
| Bend 2.0.40 itself cannot compile it (`bend -o` fails) | 20 |
| **Built by bend-emit; every `.d.mts` typechecks under `strict`** | **115 of 115** |

For comparison, bend-emit 0.4.5, which read Bend source with regular
expressions and ran the `bend` CLI, built 13 of these 115.

### Differential Check of the Passes

For each of the 115 packages, each exported def with generated inputs
(numbers, strings, lists, options) was called twice: once in Bend's
unmodified module, and once in the module after bend-emit's passes. Results:

- 1,417 defs and 17,656 calls, with **0 mismatches**.
- In 9 calls, Bend's module overflowed the stack and the rewritten module
  returned a value.
- In 5 packages, Bend's own module did not finish within the time budget.

That run took Bend's module from the `bend` CLI. The in-process JavaScript is
identical to the CLI's, from `// Program` on, for all 115 packages, and the
passes did not change, so the result carries over.

### Benchmark: bend-csv

[bend-csv](https://github.com/nohzafk/bend-csv) is an RFC 4180 parser with
proved laws. Its `bench_js.ts` parses a generated corpus in a fresh process
per run, best of 3, with peak resident memory from `time -l`. The comparison
is Deno's `@std/csv` (Bun, Apple Silicon):

| Input | bend-csv, emitted | Deno `@std/csv` |
| :--- | :--- | :--- |
| 64 KB | 6 ms, 28 MB | 4 ms, 23 MB |
| 256 KB | 12 ms, 36 MB | 10 ms, 33 MB |
| 1 MB | 37 ms, 100 MB | 38 ms, 50 MB |
| 10 MB | 234 ms, 396 MB | 318 ms, 299 MB |

The parser's code is byte-identical to the 0.4.5 build, and the times match
it within noise. The peak memory reflects the parser's design: it allocates
a token per character and reads the input three times. bend-emit does not
cause it.
