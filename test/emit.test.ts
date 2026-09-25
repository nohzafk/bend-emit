// src/emit.ts on Base's generic types: what the .d.ts says, what crosses
// at run time, and what is refused. test.sh builds dist/ first.

import { describe, expect, test } from "bun:test";
import { declarations, readDecls } from "../src/emit";
import { readFileSync } from "node:fs";
import { first_big, side, sum_or_err, unit, unwrap, type BendList } from "./dist/generics.js";
import { first_or_none, wrap } from "./dist/uses.js";

function list<T>(xs: T[]): BendList<T> {
  return xs.reduceRight<BendList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

// The signature the tool writes for a one-def source.
function sig(header: string): string {
  const { datas, defs } = readDecls(`type Err is Data:\n  Empty{}\n\n${header}\n  x\n`);
  const scope = new Map(datas.map((d) => [d.name, d.name] as [string, string]));
  return declarations([{ prefix: "", datas, scope }], defs).split("\n").find((l) => l.startsWith("export declare function"))!;
}

describe("the .d.ts", () => {
  test("each generic maps to its TypeScript type, nested too", () => {
    expect(sig("def f(m: Maybe<&2, Nat>) -> Maybe<Nat>:")).toBe("export declare function f(m: BendMaybe<bigint>): BendMaybe<bigint>;");
    expect(sig("def f(r: Result<&2, &2, Err, List<&2, Nat>>) -> Unit:")).toBe(
      "export declare function f(r: BendResult<Err, BendList<bigint>>): BendUnit;",
    );
    expect(sig("def f(e: Either<Nat, Bool>) -> List<Maybe<Nat>>:")).toBe(
      "export declare function f(e: BendEither<bigint, boolean>): BendList<BendMaybe<bigint>>;",
    );
  });

  test("a use with the wrong number of quantities or types is refused", () => {
    expect(() => sig("def f(m: Maybe<&2, &2, Nat>) -> Nat:")).toThrow("Maybe takes 1 type(s)");
    expect(() => sig("def f(r: Result<&2, Err, Nat>) -> Nat:")).toThrow("Result takes 2 type(s)");
    expect(() => sig("def f(r: Result<Nat>) -> Nat:")).toThrow("Result takes 2 type(s)");
    expect(() => sig("def f(l: List<Nat, &2>) -> Nat:")).toThrow("List takes 1 type(s)");
  });

  test("a generic the tool has no encoding for is refused, by name", () => {
    expect(() => sig("def f(m: Map<&2, Nat>) -> Nat:")).toThrow("generic Bend type Map");
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

describe("a core that imports another", () => {
  test("the imported types are declared under the alias, and used by name", () => {
    const dts = readFileSync(new URL("./dist/uses.d.ts", import.meta.url), "utf8");
    expect(dts).toContain('export type G_Err = { $: "Empty" } | { $: "TooBig"; "index": bigint; "got": bigint };');
    expect(dts).toContain('export type Wrapped = { $: "Wrapped"; "err": G_Err };');
    expect(dts).toContain("export declare function first_or_none(xs: BendList<bigint>, lim: bigint): BendMaybe<G_Err>;");
  });
  test("its defs run, on the imported module's values", () => {
    expect(first_or_none(list([1n, 9n]), 5n)).toEqual({ $: "Some", value: { $: "TooBig", index: 1n, got: 9n } });
    expect(wrap({ $: "Empty" })).toEqual({ $: "Wrapped", err: { $: "Empty" } });
  });
});

describe("a def with a template parameter", () => {
  test("readDecls reads the def, and its ~ parameter survives", () => {
    const { defs } = readDecls("def pick(~f: Nat -> Bool, n: Nat) -> Bool:\n  f(n)\n");
    const d = defs.find((x) => x.name === "pick");
    expect(d).toBeDefined();
    expect(d!.params.map(([n]) => n)).toContain("~f");
  });

  test("the tool skips it: not declared in the .d.ts, module still imports", async () => {
    const dts = readFileSync(new URL("./dist/templated.d.ts", import.meta.url), "utf8");
    expect(dts).not.toContain("export declare function pick");
    const mod = await import("./dist/templated.js");
    expect(Object.keys(mod.default)).not.toContain("pick");
  });
});

describe("generic data, and types that depend on a value", () => {
  test("a generic data type is declared with its parameters, and used applied", () => {
    const dts = readFileSync(new URL("./dist/dependent.d.ts", import.meta.url), "utf8");
    expect(dts).toContain('export type Two<A, B> = { $: "Two"; "a": A; "b": B };');
    expect(dts).toContain("export declare function swap(t: Two<bigint, string>): Two<string, bigint>;");
  });

  test("a type computed by a def, and a def over one or with an erased parameter, are not declared", () => {
    const dts = readFileSync(new URL("./dist/dependent.d.ts", import.meta.url), "utf8");
    for (const d of ["Pick", "zero", "id"]) expect(dts).not.toContain(`export declare function ${d}(`);
    expect(dts).toContain("export declare function id_nat(n: bigint): bigint;");
  });

  test("they still run: the module keeps them, undeclared", async () => {
    const mod = (await import("./dist/dependent.js")).default as Record<string, (...a: unknown[]) => unknown>;
    expect(mod.swap({ $: "Two", a: 1n, b: "x" })).toEqual({ $: "Two", a: "x", b: 1n });
    expect(mod.id_nat(7n)).toBe(7n);
    expect(Object.keys(mod)).toContain("zero");
  });

  test("a type computed by an imported def (D.Pick) keeps a def over it out of the .d.ts", () => {
    const dts = readFileSync(new URL("./dist/dependent_user.d.ts", import.meta.url), "utf8");
    expect(dts).not.toContain("export declare function zero_of(");
    expect(dts).toContain("export declare function one(): bigint;");
  });

  test("a type parameter of a kind other than Data is refused, by name", () => {
    expect(() => readDecls("type F<T: Type> is Data:\n  F{x: T}\n")).toThrow("type F: a type parameter of kind Type");
  });
});
