// src/emit.ts on Base's generic types: what the .d.mts says, what crosses
// at run time, and what is refused. test.sh builds dist/ first.

import { describe, expect, test } from "bun:test";
import { declarations, readDecls } from "../src/emit";
import { readdirSync, readFileSync } from "node:fs";
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
    expect(sig("def f(m: Maybe<&2, Nat>) -> Maybe<Nat>:")).toBe("export declare function f(m: BendMaybe<bigint>): BendMaybe<bigint>;");
    expect(sig("def f(r: Result<&2, &2, Err, List<&2, Nat>>) -> Unit:")).toBe(
      "export declare function f(r: BendResult<Err, BendList<bigint>>): BendUnit;",
    );
    expect(sig("def f(e: Either<Nat, Bool>) -> List<Maybe<Nat>>:")).toBe(
      "export declare function f(e: BendEither<bigint, boolean>): BendList<BendMaybe<bigint>>;",
    );
    expect(sig("def f(m: Map<&2, Nat>) -> Map<Nat>:")).toBe(
      "export declare function f(m: BendMap<bigint>): BendMap<bigint>;",
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
  const stems = ["generics", "uses", "reuses", "templated", "dependent", "dependent_user", "chars", "maps", "strings", "runtime_names"];

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
    expect(sum_or_err(list([1n, 2n, 3n]), 5n)).toEqual({ $: "Done", value: 6n });
    expect(sum_or_err(list([1n, 9n, 7n]), 5n)).toEqual({ $: "Fail", error: { $: "TooBig", index: 1n, got: 9n } });
    expect(sum_or_err(list<bigint>([]), 5n)).toEqual({ $: "Fail", error: { $: "Empty" } });
  });

  test("Maybe, Either and Unit, out and in", () => {
    expect(first_big(list([1n]), 5n, 0n)).toEqual({ $: "None" });
    expect(unwrap({ $: "Some", value: 7n }, 1n)).toBe(7n);
    expect(unwrap({ $: "None" }, 1n)).toBe(1n);
    expect(side(true, 4n)).toEqual({ $: "Inl", value: 4n });
    expect(side(false, 4n)).toEqual({ $: "Inr", value: false });
    expect(unit(0n)).toEqual({ $: "Unit" });
  });
});

describe("Map on the boundary", () => {
  test("declares the native tree and recursive mapped values", () => {
    const dts = readFileSync(new URL("./dist/maps.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type BendMap<T> = { $: "MTip" } | { $: "MLeaf"; key: string; val: T } | { $: "MNode"; pos: bigint; lo: BendMap<T>; hi: BendMap<T> };');
    expect(dts).toContain('"children": BendMap<Value>');
  });

  test("empty, insert, overwrite, lookup, and bigint node positions", () => {
    const zero = empty();
    expect(zero).toEqual({ $: "MTip" });
    const one = insert(zero, "a", 1n);
    expect(one).toEqual({ $: "MLeaf", key: "a", val: 1n });
    const two = insert(one, "b", 2n);
    expect(two.$).toBe("MNode");
    if (two.$ === "MNode") expect(typeof two.pos).toBe("bigint");
    expect(lookup(two, "a", 99n)).toBe(1n);
    expect(lookup(two, "b", 99n)).toBe(2n);
    expect(lookup(two, "missing", 99n)).toBe(99n);
    const updated = insert(two, "a", 3n);
    expect(lookup(updated, "a", 99n)).toBe(3n);
    expect(lookup(updated, "b", 99n)).toBe(2n);
    expect(lookup(two, "a", 99n)).toBe(1n);
  });

  test("a host-built leaf and recursive map value round-trip", () => {
    const input: BendMap<bigint> = { $: "MLeaf", key: "x", val: 7n };
    expect(lookup(input, "x", 0n)).toBe(7n);
    const value = { $: "Branch" as const, children: { $: "MLeaf" as const, key: "child", val: { $: "Leaf" as const, n: 42n } } };
    expect(value_identity(value)).toEqual(value);
  });
});

describe("a core that imports another", () => {
  test("the imported types are declared under the alias, and used by name", () => {
    const dts = readFileSync(new URL("./dist/uses.d.mts", import.meta.url), "utf8");
    expect(dts).toContain('export type G_Err = { $: "Empty" } | { $: "TooBig"; "index": bigint; "got": bigint };');
    expect(dts).toContain('export type Wrapped = { $: "Wrapped"; "err": G_Err };');
    expect(dts).toContain("export declare function first_or_none(xs: BendList<bigint>, lim: bigint): BendMaybe<G_Err>;");
  });
  test("its defs run, on the imported module's values", () => {
    expect(first_or_none(list([1n, 9n]), 5n)).toEqual({ $: "Some", value: { $: "TooBig", index: 1n, got: 9n } });
    expect(wrap({ $: "Empty" })).toEqual({ $: "Wrapped", err: { $: "Empty" } });
  });
  test("an imported constructor's tag is its bare name, whatever the compiler writes", () => {
    const js = readFileSync(new URL("./dist/uses.mjs", import.meta.url), "utf8");
    expect(js).not.toMatch(/"generics\.[A-Z]/);
    // the tag is written with a space, either in a literal or in a constructor class.
    expect(js).toMatch(/\$: "TooBig"|this\.\$ = "TooBig"/);
  });
});

describe("a core that reaches a file only through another import", () => {
  // reuses.bend imports uses.bend, which imports generics.bend: the module
  // carries generics' defs under "generics.", the prefix uses.bend gives them.
  test("its exports are its own defs, and they run", async () => {
    const mod = await import("./dist/reuses.mjs");
    const keys = Object.keys(mod.default);
    expect(keys.filter((k) => !k.startsWith("uses.") && !k.startsWith("generics."))).toEqual(["rewrap"]);
    expect(keys.some((k) => k.startsWith("generics."))).toBe(true);
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
    expect(dts).toContain("export declare function swap(t: Two<bigint, string>): Two<string, bigint>;");
  });

  test("a type computed by a def, and a def over one or with an erased parameter, are not declared", () => {
    const dts = readFileSync(new URL("./dist/dependent.d.mts", import.meta.url), "utf8");
    for (const d of ["Pick", "zero", "id"]) expect(dts).not.toContain(`export declare function ${d}(`);
    expect(dts).toContain("export declare function id_nat(n: bigint): bigint;");
  });

  test("they still run: the module keeps them, undeclared", async () => {
    const mod = (await import("./dist/dependent.mjs")).default as Record<string, (...a: unknown[]) => unknown>;
    expect(mod.swap({ $: "Two", a: 1n, b: "x" })).toEqual({ $: "Two", a: "x", b: 1n });
    expect(mod.id_nat(7n)).toBe(7n);
    expect(Object.keys(mod)).toContain("zero");
  });

  test("a type computed by an imported def (D.Pick) keeps a def over it out of the .d.mts", () => {
    const dts = readFileSync(new URL("./dist/dependent_user.d.mts", import.meta.url), "utf8");
    expect(dts).not.toContain("export declare function zero_of(");
    expect(dts).toContain("export declare function one(): bigint;");
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
    expect([m.run_lib(3n), m.run_loop(3n), m.nat_host(true), m.cmp_new("x")]).toEqual([3n, 4n, true, "x"]);
    expect(Object.keys(m).sort()).toEqual(["cmp_new", "core", "default", "message", "nat_host", "run_lib", "run_loop"]);
  });
  test("text spelling the export binding names is data, not a collision", async () => {
    const m = await import("./dist/runtime_names.mjs");
    expect(m.message()).toBe("$bend_emit $bend_emit$0");
  });
  test("a reserved word is reached through the default export only, and declared there", async () => {
    const m = await import("./dist/runtime_names.mjs");
    expect(m.default.class(2n)).toBe(2n);
    const dts = await Bun.file(new URL("./dist/runtime_names.d.mts", import.meta.url)).text();
    expect(dts).not.toContain("function class");
    expect(dts).toContain('"class"(n: bigint): bigint;');
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
