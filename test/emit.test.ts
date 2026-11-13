// src/emit.ts on Base's generic types: what the .d.mts says, what crosses
// at run time, and what is refused. test.sh builds dist/ first.

import { describe, expect, test } from "bun:test";
import { build, bundle, declarations, importPrefixes, importsOf, modules, readDecls } from "../src/emit";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { first_big, side, sum_or_err, unit, unwrap, type BendList } from "./dist/generics.mjs";
import { first_or_none, wrap } from "./dist/uses.mjs";
import { code_of, double, kind } from "./dist/chars.mjs";
import { empty, insert, lookup, value_identity, type BendMap } from "./dist/maps.mjs";

function list<T>(xs: T[]): BendList<T> {
  return xs.reduceRight<BendList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

// The signature the tool writes for a one-def source.
function sig(header: string): string {
  const { datas, defs } = readDecls(`type Err is Data:\n  Empty{}\n\n${header}\n  x\n`);
  const scope = new Map(datas.map((d) => [d.name, d.name] as [string, string]));
  return declarations([{ prefix: "", datas, scope }], defs).split("\n").find((l) => l.startsWith("export declare function"))!;
}

describe("the .d.mts", () => {
  test("each generic maps to its TypeScript type, nested too", () => {
    expect(sig("def f(m: Maybe<&2, Nat>) -> Maybe<Nat>:")).toBe("export declare function f(m: BendMaybe<number>): BendMaybe<number>;");
    expect(sig("def f(r: Result<&2, &2, Err, List<&2, Nat>>) -> Unit:")).toBe(
      "export declare function f(r: BendResult<Err, BendList<number>>): BendUnit;",
    );
    expect(sig("def f(e: Either<Nat, Bool>) -> List<Maybe<Nat>>:")).toBe(
      "export declare function f(e: BendEither<number, boolean>): BendList<BendMaybe<number>>;",
    );
    expect(sig("def f(m: Map<&2, Nat>) -> Map<Nat>:")).toBe(
      "export declare function f(m: BendMap<number>): BendMap<number>;",
    );
  });

  test("a use with the wrong number of quantities or types is refused", () => {
    expect(() => sig("def f(m: Maybe<&2, &2, Nat>) -> Nat:")).toThrow("Maybe takes 1 type(s)");
    expect(() => sig("def f(r: Result<&2, Err, Nat>) -> Nat:")).toThrow("Result takes 2 type(s)");
    expect(() => sig("def f(r: Result<Nat>) -> Nat:")).toThrow("Result takes 2 type(s)");
    expect(() => sig("def f(l: List<Nat, &2>) -> Nat:")).toThrow("List takes 1 type(s)");
    expect(() => sig("def f(m: Map<&2, &2, Nat>) -> Nat:")).toThrow("Map takes 1 type(s)");
    expect(() => sig("def f(m: Map<Nat, Bool>) -> Nat:")).toThrow("Map takes 1 type(s)");
  });

  test("a generic the tool has no encoding for is refused, by name", () => {
    expect(() => sig("def f(m: Unsupported<&2, Nat>) -> Nat:")).toThrow("generic Bend type Unsupported");
  });
});

describe("what the tool writes", () => {
  // The module is .mjs and the declaration is .d.mts, because that is the pair
  // TypeScript resolves: a .d.ts is the declaration for a .js module, and tsc
  // resolving a .mjs tries core.mts then core.d.mts and stops (measured with
  // --traceResolution). A .d.ts beside a .mjs would be a file nothing reads, so
  // the tool writes exactly these two per core and nothing else.
  const stems = ["generics", "uses", "reuses", "templated", "dependent", "dependent_user", "chars", "maps", "strings", "runtime_names", "select", "closure_last", "peel"];

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
  test("readDecls reads the def, and its ~ parameter survives", () => {
    const { defs } = readDecls("def pick(~f: Nat -> Bool, n: Nat) -> Bool:\n  f(n)\n");
    const d = defs.find((x) => x.name === "pick");
    expect(d).toBeDefined();
    expect(d!.params.map(([n]) => n)).toContain("~f");
  });

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

  test("a type parameter of a kind other than Data is refused, by name", () => {
    expect(() => readDecls("type F<T: Type> is Data:\n  F{x: T}\n")).toThrow("type F: a type parameter of kind Type");
  });
});

describe("Char, and a type body with comments and blank lines", () => {
  test("a Char crosses as a one-code-point string, both ways", () => {
    expect(sig("def f(c: Char) -> Char:")).toBe("export declare function f(c: string): string;");
    expect(double("é", "x")).toBe("ééx");
    expect(double("😀", "")).toBe("😀😀");
    expect(code_of({ $: "Other", c: "😀" })).toBe(0x1f600);
  });

  test("every constructor is read, past a comment and a blank line", () => {
    const { datas } = readDecls(readFileSync(new URL("./chars.bend", import.meta.url), "utf8"));
    expect(datas.find((d) => d.name === "Sort")!.ctors.map((c) => c.name)).toEqual(["Other", "Quote", "Sep"]);
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
    const raw = bundle(fileURLToPath(new URL("./closure_last.bend", import.meta.url)));
    expect(raw).toMatch(/^const \$\$Nat_is_le = \$Nat_is_le;export default \{$/m);
    const m = await import("./dist/closure_last.mjs");
    const xs = (ns: number[]): any => ns.reduceRight((tail: any, head) => ({ $: "Con", head, tail }), { $: "Nil" });
    expect([m.take(xs([2, 3, 4]), 5), m.take(xs([2, 3, 4]), 9), m.take(xs([]), 9)]).toEqual([2, 3, 0]);
  });
});

describe("a data type named like a type of the preamble", () => {
  test("is refused, with the reserved names", () => {
    const src = "import Base\n\ntype BendList is Data:\n  Own{}\n\ndef identity(x: BendList) -> BendList:\n  x\n";
    const { datas } = readDecls(src);
    const mod = { prefix: "", datas, scope: new Map(datas.map((d) => [d.name, d.name])) };
    expect(() => declarations([mod], [])).toThrow("type BendList: the name of a type bend-emit declares for Base");
  });
});

describe("an imported data type whose TypeScript name is another type's", () => {
  const mod = (prefix: string, names: string[]) => {
    const { datas } = readDecls(names.map((n) => `type ${n} is Data:\n  Own{}\n`).join("\n"));
    return { prefix, datas, scope: new Map(datas.map((d) => [d.name, prefix + d.name])) };
  };
  test("a local type and an import's type are refused, naming both", () => {
    expect(() => declarations([mod("", ["G_Err"]), mod("G_", ["Err"])], [])).toThrow("two types would both be written G_Err: type G_Err of the core and type Err imported as G");
    expect(() => declarations([mod("", ["G_Err"]), mod("G_", ["Err"])], [])).toThrow("type G_Err");
  });
  test("two imports' types are refused", () => {
    expect(() => declarations([mod("", []), mod("a_b_", ["T"]), mod("a_", ["b_T"])], [])).toThrow("two types would both be written a_b_T: type T imported as a_b and type b_T imported as a");
  });
  test("distinct names pass", () => {
    expect(declarations([mod("", ["A"]), mod("G_", ["Err"])], [])).toContain("export type G_Err");
  });
});

describe("source as hub packages write it", () => {
  // The first data type and the first def of a source, as read.
  const one = (src: string) => readDecls(src);

  test("a def header over several lines, its ) at the margin, with a trailing comment", () => {
    const { defs } = one("def f(\n  a: Nat,\n  +b: List<&2, Nat>,\n) ->\n  Nat:  # noqa: L001\n  a\n");
    expect(defs).toEqual([{ name: "f", params: [["a", "Nat"], ["b", "List<&2, Nat>"]], ret: "Nat", erased: false }]);
    expect(sig("def f(\n  a: Nat,\n  b: Bool\n) -> Nat:")).toBe("export declare function f(a: number, b: boolean): number;");
  });

  test("a constructor over several lines, its fields split by commas or by line breaks", () => {
    const { datas } = one("type T is Data:\n  A{x: Nat,\n    y: String}\n  B{\n    x: List<&2, Nat>\n    y: Bool\n  }\n");
    expect(datas[0].ctors).toEqual([
      { name: "A", fields: [["x", "Nat"], ["y", "String"]] },
      { name: "B", fields: [["x", "List<&2, Nat>"], ["y", "Bool"]] },
    ]);
  });

  test("a def body that looks like a constructor is not joined to what follows", () => {
    const { datas, defs } = one("def f(a: Nat, b: Nat) -> Bool:\n  Foo{a < b}\n\ntype T is Data:\n  T{}\n\ndef g() -> Nat:\n  0n\n");
    expect(datas.map((d) => d.name)).toEqual(["T"]);
    expect(defs.map((d) => d.name)).toEqual(["f", "g"]);
  });

  test("is Type, a + before a field's type, marked and long type parameters, dotted names", () => {
    const { datas } = one("type Box<-KE: Data> is Type:\n  Box.Full{xs: +List<KE>}\n  Box.None{}\n\ntype Parse.Cur is Data:\n  Cur{at: Nat}\n");
    expect(datas[0]).toEqual({ name: "Box", tparams: ["KE"], ctors: [{ name: "Box.Full", fields: [["xs", "+List<KE>"]] }, { name: "Box.None", fields: [] }] });
    const scope = new Map(datas.map((d) => [d.name, d.name.replace(/\./g, "_")] as [string, string]));
    const dts = declarations([{ prefix: "", datas, scope }], []);
    expect(dts).toContain('export type Box<KE> = { $: "Box.Full"; "xs": BendList<KE> } | { $: "Box.None" };');
    expect(dts).toContain('export type Parse_Cur = { $: "Cur"; "at": number };');
  });

  test("a def after its law (bare names, no ->) is a proof, not read; a bare name is a quantity", () => {
    const { defs } = one("def Laws.round_trip(v):\n  {==}\n\ndef k(a, -A: Kind(a), n: Nat) -> Nat:\n  n\n\ndef io?(n: Nat) -> IO(Unit):\n  IO.print(\"\")\n");
    expect(defs.map((d) => [d.name, d.erased])).toEqual([["k", true], ["io", false]]);
  });

  test("F32, Cmp, and the pair A & B, parenthesized or not", () => {
    expect(sig("def f(x: F32, c: Cmp) -> Nat & (Bool & String):")).toBe(
      "export declare function f(x: number, c: BendCmp): BendPair<number, BendPair<boolean, string>>;",
    );
    expect(sig("def f(p: List<&2, String & Nat>) -> (Nat & Nat) -> Nat:")).toBe(
      "export declare function f(p: BendList<BendPair<string, number>>): ((x: BendPair<number, number>) => number);",
    );
  });
});

describe("an import from the hub", () => {
  test("0x<hash>/ and <name>@<version>/ are read from BEND_LIB, and named as bend names them", () => {
    const lib = mkdtempSync(join(tmpdir(), "bend-emit-lib-"));
    const local = mkdtempSync(join(tmpdir(), "bend-emit-core-"));
    const hash = "0x" + "ab".repeat(16);
    mkdirSync(join(lib, hash), { recursive: true });
    mkdirSync(join(lib, "names"), { recursive: true });
    writeFileSync(join(lib, "names", "pkg@1.0.0.0"), hash + "\n");
    writeFileSync(join(lib, hash, "bytes.bend"), "import Base\nimport ./more.bend as M\n\ntype Bytes is Data:\n  Bytes{n: Nat}\n");
    writeFileSync(join(lib, hash, "more.bend"), "import Base\n");
    writeFileSync(join(local, "core.bend"), "import Base\n# a comment between imports\nimport pkg@1.0.0.0/bytes.bend as B  # bytes\nimport ./side.bend as S\n\ndef n(b: B.Bytes) -> Nat:\n  0n\n");
    writeFileSync(join(local, "side.bend"), "import Base\nimport " + hash + "/more.bend as M\n");
    const was = process.env.BEND_LIB;
    process.env.BEND_LIB = lib;
    try {
      const core = join(local, "core.bend");
      expect(importsOf(core).map((i) => [i.alias, i.path])).toEqual([
        ["B", realpathSync(join(lib, hash, "bytes.bend"))],
        ["S", realpathSync(join(local, "side.bend"))],
      ]);
      expect([...importPrefixes(core)].sort()).toEqual([hash + "/bytes:", hash + "/more:", "side:"]);
      const mods = modules(core);
      expect(mods[0].scope.get("B.Bytes")).toBe("B_Bytes");
      const { defs } = readDecls(readFileSync(core, "utf8"));
      expect(declarations(mods, defs)).toContain("export declare function n(b: B_Bytes): number;");
    } finally {
      if (was === undefined) delete process.env.BEND_LIB; else process.env.BEND_LIB = was;
    }
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
