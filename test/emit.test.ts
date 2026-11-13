// src/emit.ts on Base's generic types: what the .d.mts says, what crosses
// at run time, and what is refused. test.sh builds dist/ first.

import { describe, expect, test } from "bun:test";
import { build, bundle } from "../src/emit";
import { arities, declarations, exported, load, prefixes } from "../src/book";
import * as Bend from "../bend2/bend.ts";
import * as Comp from "../bend2/comp.ts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { first_big, side, sum_or_err, unit, unwrap, type BendList } from "./dist/generics.mjs";
import { first_or_none, wrap } from "./dist/uses.mjs";
import { code_of, double, kind } from "./dist/chars.mjs";
import { empty, insert, lookup, value_identity, type BendMap } from "./dist/maps.mjs";

function list<T>(xs: T[]): BendList<T> {
  return xs.reduceRight<BendList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

// Files in a fresh directory, by relative path; the path of core.bend.
function files(fs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bend-emit-core-"));
  for (const [p, text] of Object.entries(fs)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return join(dir, "core.bend");
}

// The .d.mts for a core, read from its checked Book. A ?TODO body checks at
// any type, so a test states a signature without a body; the build itself
// refuses a TODO.
async function dtsOf(core: string): Promise<string> {
  const book = Bend.book_nil();
  await Bend.book_load(book, core, "", new Map());
  Bend.book_valid(book, 0);
  const l = { B: Bend, book };
  return declarations(l, core, exported(l), arities(Comp.js_lib(book, true)));
}

// The signature the tool writes for a one-def source.
async function sig(header: string): Promise<string> {
  const dts = await dtsOf(files({ "core.bend": `import Base\n\ntype Err is Data:\n  Empty{}\n\n${header}\n  ?TODO\n` }));
  return dts.split("\n").find((l) => l.startsWith("export declare function"))!;
}

describe("the .d.mts", () => {
  test("each generic maps to its TypeScript type, nested too", async () => {
    expect(await sig("def f(m: Maybe<&2, Nat>) -> Maybe<Nat>:")).toBe("export declare function f(m: BendMaybe<number>): BendMaybe<number>;");
    expect(await sig("def f(r: Result<&2, &2, Err, List<&2, Nat>>) -> Unit:")).toBe(
      "export declare function f(r: BendResult<Err, BendList<number>>): BendUnit;",
    );
    expect(await sig("def f(e: Either<Nat, Bool>) -> List<Maybe<Nat>>:")).toBe(
      "export declare function f(e: BendEither<number, boolean>): BendList<BendMaybe<number>>;",
    );
    expect(await sig("def f(m: Map<&2, Nat>) -> Map<Nat>:")).toBe(
      "export declare function f(m: BendMap<number>): BendMap<number>;",
    );
  });

  test("a use with the wrong number of types is bend's to refuse", async () => {
    const core = files({ "core.bend": "import Base\n\ndef f(m: Maybe<&2, Nat, Nat>) -> Nat:\n  0n\n" });
    expect(load(core)).rejects.toThrow("bend could not compile");
  });

  test("a Base type the tool has no encoding for is refused, by name", async () => {
    expect(sig("def f(a: Image) -> Nat:")).rejects.toThrow("def f: no TypeScript encoding for the Bend type Image");
  });

  test("Array and Word are Base's encodings; Word(n) is one type whatever n is", async () => {
    expect(await sig("def f(a: Array<U32>) -> Array<Bool>:")).toBe("export declare function f(a: BendArray<number>): BendArray<boolean>;");
    expect(await sig("def f(w: Word(8n)) -> Word(0n):")).toBe("export declare function f(w: BendWord): BendWord;");
    const w = await dtsOf(files({ "core.bend": "import Base\n\ntype W<-n: Nat> is Data:\n  W{w: Word(n)}\n" }));
    expect(w).toContain('export type W = { $: "W"; "w": BendWord };');
  });

  test("a type Base declares and never defines is a branded handle", async () => {
    const h = await dtsOf(files({ "core.bend": "import Base\n\ntype H is Type:\n  H{c: Chan(Nat), f: File}\n" }));
    expect(h).toContain('export type H = { $: "H"; "c": BendHandle<"Chan", [number]>; "f": BendHandle<"File"> };');
  });

  test("a proof field is null", async () => {
    const p = await dtsOf(files({ "core.bend": "import Base\n\ntype P<-k: U32> is Data:\n  P{v: U32, ok: {v == k : U32}}\n" }));
    expect(p).toContain('export type P = { $: "P"; "v": number; "ok": null };');
  });

  test("a function with an erased type argument is generic in it; another erased argument is dropped", async () => {
    expect(await sig("def f(g: @-R: Type -> @k: (U32 -> R) -> R) -> Nat:")).toBe(
      "export declare function f(g: (<be$R0>(x: ((x: number) => be$R0)) => be$R0)): number;",
    );
    expect(await sig("def f(g: @-R: Type -> @-S: Type -> R -> S -> R) -> Nat:")).toBe(
      "export declare function f(g: (<be$R0, be$S1>(x: be$R0) => ((x: be$S1) => be$R0))): number;",
    );
    expect(await sig("def f(g: @-n: Nat -> U32 -> U32) -> Nat:")).toBe("export declare function f(g: ((x: number) => number)): number;");
 
  });

  test("a function's generic shadows no enclosing type parameter, even one written be$<name>", async () => {
    const dts = await dtsOf(files({ "core.bend": "import Base\n\ntype R0 is Data:\n  MkR0{}\n\ntype Box<-R0: Type> is Type:\n  Box{run: @-R: Type -> @k: (R0 -> R) -> R}\n" }));
    expect(dts).toContain('export type Box<be$R0> = { $: "Box"; "run": (<be$R1>(x: ((x: be$R0) => be$R1)) => be$R1) };');
  });

  test("an erased type argument the rest never names leaves the rest's type", async () => {
    expect(await sig("def f(g: @-R: Type -> U32) -> Nat:")).toBe("export declare function f(g: number): number;");
  });

  test("a function parameter, of one or of two arguments", async () => {
    expect(await sig("def f(g: Nat -> Bool, h: Nat -> Nat -> String) -> Nat:")).toBe(
      "export declare function f(g: ((x: number) => boolean), h: ((x: number) => ((x: number) => string))): number;",
    );
  });
});

describe("what the tool writes", () => {
  // The module is .mjs and the declaration is .d.mts, because that is the pair
  // TypeScript resolves: a .d.ts is the declaration for a .js module, and tsc
  // resolving a .mjs tries core.mts then core.d.mts and stops (measured with
  // --traceResolution). A .d.ts beside a .mjs would be a file nothing reads, so
  // the tool writes exactly these two per core and nothing else.
  const stems = ["generics", "uses", "reuses", "templated", "dependent", "dependent_user", "chars", "maps", "strings", "runtime_names", "select", "closure_last", "peel", "natives"];

  test("each fixture is a .mjs module and a .d.mts declaration, and nothing else", () => {
    const files = readdirSync(new URL("./dist/", import.meta.url)).sort();
    expect(files).toEqual(stems.flatMap((s) => [`${s}.d.mts`, `${s}.mjs`]).sort());
  });

  test("no .d.ts is written beside any .mjs", () => {
    const files = readdirSync(new URL("./dist/", import.meta.url));
    expect(files.filter((f) => f.endsWith(".d.ts"))).toEqual([]);
  });
});

describe("at run time", () => {
  test("Result: the first error, with its place, or the value", () => {
    expect(sum_or_err(list([1, 2, 3]), 5)).toEqual({ $: "Done", value: 6 });
    expect(sum_or_err(list([1, 9, 7]), 5)).toEqual({ $: "Fail", error: { $: "TooBig", index: 1, got: 9 } });
    expect(sum_or_err(list<number>([]), 5)).toEqual({ $: "Fail", error: { $: "Empty" } });
  });

  test("Maybe, Either and Unit, out and in", () => {
    expect(first_big(list([1]), 5, 0)).toEqual({ $: "None" });
    expect(unwrap({ $: "Some", value: 7 }, 1)).toBe(7);
    expect(unwrap({ $: "None" }, 1)).toBe(1);
    expect(side(true, 4)).toEqual({ $: "Inl", value: 4 });
    expect(side(false, 4)).toEqual({ $: "Inr", value: false });
    expect(unit(0)).toEqual({ $: "Unit" });
  });
});

describe("Map on the boundary", () => {
  test("declares the native tree and recursive mapped values", () => {
    const dts = readFileSync(new URL("./dist/maps.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type BendMap<T> = { $: "MTip" } | { $: "MLeaf"; key: string; val: T } | { $: "MNode"; pos: number; lo: BendMap<T>; hi: BendMap<T> };');
    expect(dts).toContain('"children": BendMap<Value>');
  });

  test("empty, insert, overwrite, lookup, and number node positions", () => {
    const zero = empty();
    expect(zero).toEqual({ $: "MTip" });
    const one = insert(zero, "a", 1);
    expect(one).toEqual({ $: "MLeaf", key: "a", val: 1 });
    const two = insert(one, "b", 2);
    expect(two.$).toBe("MNode");
    if (two.$ === "MNode") expect(typeof two.pos).toBe("number");
    expect(lookup(two, "a", 99)).toBe(1);
    expect(lookup(two, "b", 99)).toBe(2);
    expect(lookup(two, "missing", 99)).toBe(99);
    const updated = insert(two, "a", 3);
    expect(lookup(updated, "a", 99)).toBe(3);
    expect(lookup(updated, "b", 99)).toBe(2);
    expect(lookup(two, "a", 99)).toBe(1);
  });

  test("a host-built leaf and recursive map value round-trip", () => {
    const input: BendMap<number> = { $: "MLeaf", key: "x", val: 7 };
    expect(lookup(input, "x", 0)).toBe(7);
    const value = { $: "Branch" as const, children: { $: "MLeaf" as const, key: "child", val: { $: "Leaf" as const, n: 42 } } };
    expect(value_identity(value)).toEqual(value);
  });
});

describe("a core that imports another", () => {
  test("the imported types are declared under the alias, and used by name", () => {
    const dts = readFileSync(new URL("./dist/uses.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type G_Err = { $: "Empty" } | { $: "TooBig"; "index": number; "got": number };');
    expect(dts).toContain('export type Wrapped = { $: "Wrapped"; "err": G_Err };');
    expect(dts).toContain("export declare function first_or_none(xs: BendList<number>, lim: number): BendMaybe<G_Err>;");
  });
  test("its defs run, on the imported module's values", () => {
    expect(first_or_none(list([1, 9]), 5)).toEqual({ $: "Some", value: { $: "TooBig", index: 1, got: 9 } });
    expect(wrap({ $: "Empty" })).toEqual({ $: "Wrapped", err: { $: "Empty" } });
  });
  test("an imported constructor's tag is its bare name, whatever the compiler writes", () => {
    const js = readFileSync(new URL("./dist/uses.mjs", import.meta.url), "utf8");
    expect(js).not.toMatch(/(\$\s*[:=]|[=!]==|case)\s*"generics\.[A-Z]/);
    // the tag is written with a space, either in a literal or in a constructor class.
    expect(js).toMatch(/\$: "TooBig"|this\.\$ = "TooBig"/);
  });
});

describe("a core that reaches a file only through another import", () => {
  // reuses.bend imports uses.bend, which imports generics.bend: the module
  // carries generics' defs under "generics:", the prefix uses.bend gives them.
  test("its exports are its own defs, and they run", async () => {
    const mod = await import("./dist/reuses.mjs");
    const keys = Object.keys(mod.default);
    expect(keys.filter((k) => !k.startsWith("uses:") && !k.startsWith("generics:"))).toEqual(["rewrap"]);
    expect(keys.some((k) => k.startsWith("generics:"))).toBe(true);
    expect(Object.keys(mod).sort()).toEqual(["default", "rewrap"]);
    expect(mod.rewrap({ $: "Wrapped", err: { $: "Empty" } })).toEqual({ $: "Wrapped", err: { $: "Empty" } });
  });
});

describe("a def with a template parameter", () => {
  test("the tool skips it: not declared in the .d.mts, module still imports", async () => {
    const dts = readFileSync(new URL("./dist/templated.d.mts", import.meta.url), "utf8");
    expect(dts).not.toContain("export declare function pick");
    const mod = await import("./dist/templated.mjs");
    expect(Object.keys(mod.default)).not.toContain("pick");
  });
});

describe("generic data, and types that depend on a value", () => {
  test("a generic data type is declared with its parameters, and used applied", () => {
    const dts = readFileSync(new URL("./dist/dependent.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type Two<A, B> = { $: "Two"; "a": A; "b": B };');
    expect(dts).toContain("export declare function swap(t: Two<number, string>): Two<string, number>;");
  });

  test("a type computed by a def, and a def over one or with an erased parameter, are not declared", () => {
    const dts = readFileSync(new URL("./dist/dependent.d.mts", import.meta.url), "utf8");
    for (const d of ["Pick", "zero", "id"]) expect(dts).not.toContain(`export declare function ${d}(`);
    expect(dts).toContain("export declare function id_nat(n: number): number;");
  });

  test("they still run: the module keeps them, undeclared", async () => {
    const mod = (await import("./dist/dependent.mjs")).default as Record<string, (...a: unknown[]) => unknown>;
    expect(mod.swap({ $: "Two", a: 1, b: "x" })).toEqual({ $: "Two", a: "x", b: 1 });
    expect(mod.id_nat(7)).toBe(7);
    expect(Object.keys(mod)).toContain("zero");
  });

  test("a type computed by an imported def (D.Pick) keeps a def over it out of the .d.mts", () => {
    const dts = readFileSync(new URL("./dist/dependent_user.d.mts", import.meta.url), "utf8");
    expect(dts).not.toContain("export declare function zero_of(");
    expect(dts).toContain("export declare function one(): number;");
  });

  test("a type parameter of kind Type is declared; an index is dropped; a higher kind is refused, by name", async () => {
    const box = await dtsOf(files({ "core.bend": "import Base\n\ntype Box<T: Type> is Type:\n  Box{x: T}\n" }));
    expect(box).toContain('export type Box<T> = { $: "Box"; "x": T };');
    const vec = await dtsOf(files({ "core.bend": "import Base\n\ntype Vec<-n: Nat, -T: Type> is Type:\n  Vec{x: T}\n\ndef f(v: Vec<3n, Bool>) -> Nat:\n  ?TODO\n" }));
    expect(vec).toContain('export type Vec<T> = { $: "Vec"; "x": T };');
    expect(vec).toContain("export declare function f(v: Vec<boolean>): number;");
    const hk = files({ "core.bend": "import Base\n\ntype F<-K: Type -> Type> is Type:\n  F{x: K(Nat)}\n" });
    expect(dtsOf(hk)).rejects.toThrow("type F: a type parameter of kind");
  });
});

describe("Char, and a type body with comments and blank lines", () => {
  test("a Char crosses as a one-code-point string, both ways", async () => {
    expect(await sig("def f(c: Char) -> Char:")).toBe("export declare function f(c: string): string;");
    expect(double("é", "x")).toBe("ééx");
    expect(double("😀", "")).toBe("😀😀");
    expect(code_of({ $: "Other", c: "😀" })).toBe(0x1f600);
  });

  test("every constructor is declared, past a comment and a blank line", () => {
    const dts = readFileSync(new URL("./dist/chars.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type Sort = { $: "Other"; "c": string } | { $: "Quote" } | { $: "Sep" };');
    expect(kind("\"")).toEqual({ $: "Quote" });
    expect(kind(",")).toEqual({ $: "Sep" });
    expect(kind("a")).toEqual({ $: "Other", c: "a" });
  });
});

describe("a def named like a function of bend's runtime", () => {
  test("the module loads, and each def is exported under its own name", async () => {
    const m = await import("./dist/runtime_names.mjs");
    expect([m.run_lib(3), m.run_loop(3), m.nat_host(true), m.cmp_new("x")]).toEqual([3, 4, true, "x"]);
    expect(Object.keys(m).sort()).toEqual(["cmp_new", "core", "default", "keywords", "message", "nat_host", "run_lib", "run_loop"]);
  });
  test("text spelling the export binding names is data, not a collision", async () => {
    const m = await import("./dist/runtime_names.mjs");
    expect(m.message()).toBe("be$default be$0");
  });
  test("a reserved word is reached through the default export only, and declared there", async () => {
    const m = await import("./dist/runtime_names.mjs");
    expect(m.default.class(2)).toBe(2);
    const dts = await Bun.file(new URL("./dist/runtime_names.d.mts", import.meta.url)).text();
    expect(dts).not.toContain("function class");
    expect(dts).toContain('"class"(n: number): number;');
  });
  test("the default object is be$default, beside a def named core", async () => {
    const dts = await Bun.file(new URL("./dist/runtime_names.d.mts", import.meta.url)).text();
    expect(dts).toContain("export declare function core(n: number): number;");
    expect(dts).toContain("declare const be$default: {");
    expect(dts).toContain("export default be$default;");
    expect(dts).not.toContain("$bend_emit");
  });
  test("a parameter that is a reserved word is written be$<name>; ordinary ones stay", async () => {
    const dts = await Bun.file(new URL("./dist/runtime_names.d.mts", import.meta.url)).text();
    expect(dts).toContain("export declare function keywords(be$class: number, be$default: number): number;");
    expect(dts).toContain("export declare function core(n: number): number;");
    const m = await import("./dist/runtime_names.mjs");
    expect(m.keywords(1, 2)).toBe(3);
  });
});

describe("a module whose export default is not on a line of its own", () => {
  test("bend's `const $f = $f;export default {` is read, and the module runs", async () => {
    const raw = await bundle(fileURLToPath(new URL("./closure_last.bend", import.meta.url)));
    expect(raw).toMatch(/^const \$\$Nat_is_le = \$Nat_is_le;export default \{$/m);
    const m = await import("./dist/closure_last.mjs");
    const xs = (ns: number[]): any => ns.reduceRight((tail: any, head) => ({ $: "Con", head, tail }), { $: "Nil" });
    expect([m.take(xs([2, 3, 4]), 5), m.take(xs([2, 3, 4]), 9), m.take(xs([]), 9)]).toEqual([2, 3, 0]);
  });
});

describe("a data type named like a type of the preamble", () => {
  test("is refused, with the reserved names", async () => {
    const core = files({ "core.bend": "import Base\n\ntype BendList is Data:\n  Own{}\n\ndef identity(x: BendList) -> BendList:\n  x\n" });
    expect(dtsOf(core)).rejects.toThrow("type BendList of the core: the name of a type bend-emit declares for Base");
  });
});

describe("an imported data type whose TypeScript name is another type's", () => {
  const own = (names: string[]) => names.map((n) => `type ${n} is Data:\n  ${n}.Own{}\n`).join("\n");
  test("a local type and an import's type are refused, naming both", async () => {
    const core = files({ "core.bend": `import Base\nimport ./g.bend as G\n\n${own(["G_Err"])}`, "g.bend": `import Base\n\n${own(["Err"])}` });
    expect(dtsOf(core)).rejects.toThrow("two types would both be written G_Err: type G_Err of the core and type Err imported as G");
  });
  test("two imports' types are refused", async () => {
    const core = files({
      "core.bend": "import Base\nimport ./a.bend as a\n",
      "a.bend": `import Base\nimport ./b.bend as b\n\n${own(["b_T"])}`,
      "b.bend": `import Base\n\n${own(["T"])}`,
    });
    expect(dtsOf(core)).rejects.toThrow("two types would both be written a_b_T");
  });
  test("distinct names pass", async () => {
    const core = files({ "core.bend": `import Base\nimport ./g.bend as G\n\n${own(["A"])}`, "g.bend": `import Base\n\n${own(["Err"])}` });
    expect(await dtsOf(core)).toContain("export type G_Err");
  });
  test("a file reached two ways is declared once, and its other name is an alias", async () => {
    const core = files({
      "core.bend": "import Base\nimport ./g.bend as G\nimport ./h.bend as H\n",
      "h.bend": "import Base\nimport ./g.bend as G\n",
      "g.bend": `import Base\n\n${own(["Err"])}`,
    });
    const dts = await dtsOf(core);
    expect(dts).toContain('export type G_Err = { $: "Err.Own" };');
    expect(dts).toContain("export type H_G_Err = G_Err;");
  });
});

describe("source as hub packages write it", () => {
  test("a def header over several lines, with a trailing comment", async () => {
    expect(await sig("def f(\n  a: Nat,\n  +b: List<&2, Nat>,\n) ->\n  Nat:  # noqa: L001")).toBe(
      "export declare function f(a: number, b: BendList<number>): number;",
    );
  });

  test("is Type, a + before a field's type, marked type parameters, dotted names", async () => {
    const dts = await dtsOf(files({ "core.bend": "import Base\n\ntype Box<-KE: Data> is Type:\n  Box.Full{xs: +List<KE>}\n  Box.None{}\n\ntype Parse.Cur is Data:\n  Cur{at: Nat}\n" }));
    expect(dts).toContain('export type Box<KE> = { $: "Box.Full"; "xs": BendList<KE> } | { $: "Box.None" };');
    expect(dts).toContain('export type Parse_Cur = { $: "Cur"; "at": number };');
  });

  test("a def with an erased quantity or type parameter is not declared", async () => {
    const dts = await dtsOf(files({ "core.bend": "import Base\n\ndef k(a, -A: Kind(a), n: Nat) -> Nat:\n  n\n\ndef m(n: Nat) -> Nat:\n  n\n" }));
    expect(dts).not.toContain("function k(");
    expect(dts).toContain("export declare function m(n: number): number;");
  });

  test("F32, Cmp, and the pair A & B, parenthesized or not", async () => {
    expect(await sig("def f(x: F32, c: Cmp) -> Nat & (Bool & String):")).toBe(
      "export declare function f(x: number, c: BendCmp): BendPair<number, BendPair<boolean, string>>;",
    );
    expect(await sig("def f(p: List<&2, +Sigma<String, _ => Nat>>, g: (Nat & Nat) -> Nat) -> Nat:")).toBe(
      "export declare function f(p: BendList<BendPair<string, number>>, g: ((x: BendPair<number, number>) => number)): number;",
    );
  });
});

describe("an import from the hub", () => {
  test("0x<hash>/ and <name>@<version>/ are read from BEND_LIB, and named as bend names them", async () => {
    const lib = mkdtempSync(join(tmpdir(), "bend-emit-lib-"));
    const hash = "0x" + "ab".repeat(16);
    mkdirSync(join(lib, hash), { recursive: true });
    mkdirSync(join(lib, "names"), { recursive: true });
    writeFileSync(join(lib, "names", "pkg@1.0.0.0"), hash + "\n");
    writeFileSync(join(lib, hash, "bytes.bend"), "import Base\nimport ./more.bend as M\n\ntype Bytes is Data:\n  Bytes{n: Nat}\n");
    writeFileSync(join(lib, hash, "more.bend"), "import Base\n");
    const core = files({
      "core.bend": "import Base\n# a comment between imports\nimport pkg@1.0.0.0/bytes.bend as B  # bytes\nimport ./side.bend as S\n\ndef n(b: B.Bytes) -> Nat:\n  0n\n",
      "side.bend": "import Base\nimport " + hash + "/more.bend as M\n",
    });
    const was = process.env.BEND_LIB;
    process.env.BEND_LIB = lib;
    try {
      expect(Object.fromEntries(prefixes(core))).toEqual({ "": [""], [hash + "/bytes:"]: ["B_"], "side:": ["S_"], [hash + "/more:"]: ["B_M_", "S_M_"] });
    } finally {
      if (was === undefined) delete process.env.BEND_LIB; else process.env.BEND_LIB = was;
    }
    // bend reads BEND_LIB once, when it loads: the build runs in a process of its own.
    const out = join(dirname(core), "out");
    const run = Bun.spawnSync(["bun", fileURLToPath(new URL("../src/emit.ts", import.meta.url)), core, out], { env: { ...process.env, BEND_LIB: lib } });
    expect(run.stderr.toString()).toBe("");
    const dts = readFileSync(join(out, "core.d.mts"), "utf8");
    expect(dts).toContain('export type B_Bytes = { $: "Bytes"; "n": number };');
    expect(dts).toContain("export declare function n(b: B_Bytes): number;");
  });
});

describe("what the runtime holds, not only what the type says", () => {
  const built = async (src: string) => {
    const core = files({ "core.bend": "import Base\n\n" + src });
    const r = await build(core, join(dirname(core), "out"));
    return { dts: readFileSync(r.dts, "utf8"), mod: await import(r.js) };
  };

  test("an erased field is not declared: the runtime's object has none", async () => {
    const { dts, mod } = await built("type T is Data:\n  C{-ghost: Nat, x: Nat}\n\ndef make(n: Nat) -> T:\n  C{0n, n}\n");
    expect(dts).toContain('export type T = { $: "C"; "x": number };');
    expect(mod.make(4)).toEqual({ $: "C", x: 4 });
  });

  test("a returned function the module finishes is declared, and runs both ways", async () => {
    const { dts, mod } = await built("def add(a: Nat) -> Nat -> Nat:\n  b => (a + b : Nat)\n");
    expect(dts).toContain("export declare function add(a: number): ((x: number) => number);");
    expect(mod.add(2)(3)).toBe(5);
  });

  test("a returned function the module returns unfinished is refused", async () => {
    const src = "def Fn() -> Type:\n  String -> String\n\ndef id(s: String) -> String:\n  s\n\ndef f(n: Nat) -> Fn:\n  id\n";
    expect(built(src)).rejects.toThrow("def f: it returns a function bend's module returns unfinished (it takes 1 of 2 arguments)");
  });

  test("a type named like a TypeScript keyword is refused; such a type parameter is renamed", async () => {
    expect(built("type class is Data:\n  C{}\n")).rejects.toThrow("cannot name a TypeScript type");
    const { dts } = await built("type T<class: Data> is Data:\n  C{value: class}\n");
    expect(dts).toContain('export type T<be$class> = { $: "C"; "value": be$class };');
  });

  test("an alias with many underscores does not stop the import walk", async () => {
    const a = "A" + "_".repeat(62);
    const core = files({
      "core.bend": `import Base\nimport ./a.bend as ${a}\n`,
      "a.bend": "import Base\nimport ./b.bend as B\n",
      "b.bend": "import Base\n\ntype T is Data:\n  C{}\n",
    });
    expect(await dtsOf(core)).toContain(`export type ${a}_B_T = { $: "C" };`);
  });
});

describe("a def that returns IO", () => {
  test("with parameters, bend exports it: it stays in the module, undeclared; main does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bend-emit-io-"));
    const core = join(dir, "io.bend");
    writeFileSync(core, "import Base\n\ndef add(a: Nat, b: Nat) -> Nat:\n  (a + b : Nat)\n\ndef hello(n: Nat) -> IO(Unit):\n  IO.print(\"hi\")\n\ndef main() -> IO(Unit):\n  IO.print(\"main\")\n");
    const r = await build(core, join(dir, "out"));
    const dts = readFileSync(r.dts, "utf8");
    expect(dts).toContain("export declare function add(a: number, b: number): number;");
    expect(dts).not.toContain("hello");
    expect(Object.keys((await import(r.js)).default).sort()).toEqual(["add", "hello"]);
  });
});

describe("Base's Array and Word, indexed types, proofs and polymorphic fields at run time", () => {
  test("an Array is a JS array; a def it is passed to may change it in place", async () => {
    const { filled, first, put } = await import("./dist/natives.mjs");
    expect(filled(5)).toEqual([5, 5, 5, 5]);
    expect(first([7, 8, 9, 10])).toBe(7);
    const a = [1, 2, 3, 4];
    expect(put(a)).toEqual([1, 99, 3, 4]);
    expect(a).toEqual([1, 99, 3, 4]);
  });

  test("a Word is its WCon cells, low bit first", async () => {
    const { bits, low } = await import("./dist/natives.mjs");
    const w = bits(true);
    expect(w).toEqual({ $: "WCon", head: true, tail: { $: "WCon", head: false, tail: { $: "WCon", head: true, tail: { $: "WNil" } } } });
    expect(low(w)).toBe(true);
  });

  test("an index is not in the value; a proof is null", async () => {
    const { pair, fits } = await import("./dist/natives.mjs");
    expect(pair(3)).toEqual({ $: "Vec", xs: { $: "Con", head: 3, tail: { $: "Con", head: 3, tail: { $: "Nil" } } } });
    expect(fits(5)).toEqual({ $: "Fits", v: 5, ok: null });
  });

  test("a polymorphic field is a function of its runtime arguments only, both ways", async () => {
    const { boxed, unbox } = await import("./dist/natives.mjs");
    expect(boxed(4).run((y: number) => [y])).toEqual([4]);
    expect(unbox({ $: "Box", run: (k) => k(1) })).toBe(11);
  });

  test("an unused erased type argument is not a function at run time", async () => {
    const { konst } = await import("./dist/natives.mjs");
    expect(konst(5)).toEqual({ $: "Konst", run: 5 });
  });

  test("the declaration says so", () => {
    const dts = readFileSync(new URL("./dist/natives.d.mts", import.meta.url), "utf8");
    expect(dts).toContain("export declare function put(a: BendArray<number>): BendArray<number>;");
    expect(dts).toContain("export declare function bits(b: boolean): BendWord;");
    expect(dts).toContain("export declare function pair(x: number): Vec;");
    expect(dts).toContain("export declare function fits(x: number): Fits;");
    expect(dts).toContain('export type Box = { $: "Box"; "run": (<be$R0>(x: ((x: number) => be$R0)) => be$R0) };');
    expect(dts).toContain('export type Konst = { $: "Konst"; "run": number };');
  });
});
