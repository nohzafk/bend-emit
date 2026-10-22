// Base's String comparison, made native by src/intrinsics.ts: the order
// bend-emit's hosts rely on, at any length, beside defs named like bend-emit's
// helpers, and the same Cmp as the String.order.go bend emits.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bundle } from "../src/emit";
import { intrinsics } from "../src/intrinsics";
import { count_eq, pk_eq, pk_gt, pk_lt, s_eq, s_gt, s_lt, str_order, unwind } from "./dist/strings.mjs";

// Bend's reading of a host string: one Char per code point. A lone surrogate
// does not cross: the module's str_in makes it U+FFFD first (since bend 2.0.38).
function chars(s0: string): number[] {
  const s = s0.replace(/\p{Cs}/gu, "\uFFFD");
  const out: number[] = [];
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!;
    out.push(c);
    i += c > 0xffff ? 2 : 1;
  }
  return out;
}
// Base's String order as a list order: first differing Char, else the shorter.
function ref(a: string, b: string): number {
  const x = chars(a), y = chars(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

// A 32-bit LCG: Math.imul keeps the product exact (a float product past 2^53
// drops its low bits, and the sequence collapses to a fixed point).
const lcg = (seed: number) => (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff), (seed >>> 16) % n);

const pool = ["", "a", "b", "ab", "ba", "aa", "\u00e9", "\ue000", "\uffff", "\u{1f600}", "\u{10000}", "\ud800", "\udc00", "\ud800x", "x\udc00", "\u{1f600}a"];

test("order equals Base's, including astral and lone surrogates", () => {
  const rnd = lcg(7);
  const word = () => Array.from({ length: rnd(4) }, () => pool[rnd(pool.length)]).join("");
  for (let i = 0; i < 20000; i++) {
    const a = word(), b = rnd(4) === 0 ? a : word();
    const r = ref(a, b);
    expect([s_eq(a, b), s_lt(a, b), s_gt(a, b)]).toEqual([r === 0, r < 0, r > 0]);
  }
});

test("by code point, not by UTF-16 unit: U+1F600 sorts above U+E000", () => {
  expect("\u{1f600}" < "\ue000").toBe(true); // JavaScript's own order
  expect(s_lt("\ue000", "\u{1f600}")).toBe(true);
  expect(s_gt("\u{1f600}", "\ue000")).toBe(true);
});

test("a long shared prefix: no RangeError", () => {
  const p = "k".repeat(300000);
  expect(s_eq(p + "a", p + "a")).toBe(true);
  expect(s_lt(p + "a", p + "b")).toBe(true);
  expect(s_eq(p, p + "a")).toBe(false);
});

test("defs named like the generated helpers: the module loads and both run", () => {
  // `unwind` is the name of bend-emit's loop helper but for its be$ prefix;
  // count_eq is a recursion that only the loop pass makes safe at this depth.
  expect(unwind(5)).toBe(5);
  expect(str_order("a", "b")).toBe(0);
  let xs: any = { $: "Nil" };
  for (let i = 0; i < 200000; i++) xs = { $: "Con", head: i % 2 ? "x" : "y", tail: xs };
  expect(count_eq("x", xs)).toBe(100000);
});

// A Bend list of Char codes, as a host passes one in.
const list = (xs: number[]) => xs.reduceRight<any>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
const codeRef = (x: number[], y: number[]) => {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
};
// Scalars of each width, lone surrogates, and codes past U+10FFFF: the last two
// kinds are packed Chars, which only a string built in Bend holds.
const codes = [0x61, 0x62, 0xe9, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f600, 0x10ffff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0x110000, 0x7fffffff, 0xffffffff];

test("order equals Base's on packed non-scalar Chars", () => {
  const rnd = lcg(11);
  const word = () => Array.from({ length: rnd(4) }, () => codes[rnd(codes.length)]);
  for (let i = 0; i < 5000; i++) {
    const a = word(), b = rnd(4) === 0 ? a.slice() : word();
    const r = codeRef(a, b);
    expect([pk_eq(list(a), list(b)), pk_lt(list(a), list(b)), pk_gt(list(a), list(b))]).toEqual([r === 0, r < 0, r > 0]);
  }
});

// The native def against the one bend emits, both run on bend's own runtime
// helpers, on strings built by bend's char_new (packed Chars included), from
// every starting Cmp.
const defOf = (js: string, name: string) => {
  const m = js.match(new RegExp(`^(?:function ${name.replace(/\$/g, "\\$")}\\(|const ${name} = function)[\\s\\S]*?\\n\\};?$`, "m"));
  if (!m) throw new Error(`${name} is not in the module`);
  return m[0];
};

test("the native String.order.go returns what bend's own returns", () => {
  const js = bundle(new URL("./strings.bend", import.meta.url).pathname);
  const runtime = ["char_new", "char_len", "char_code", "cmp_new"].map((n) => defOf(js, n)).join("\n");
  const r = intrinsics(js);
  expect(r.native.map((n) => n.name)).toEqual(["$String_order_go"]);
  expect(r.skipped).toEqual([]);
  const own = defOf(js, "$String_order_go"), native = defOf(r.js, "$String_order_go");
  expect(native).toContain("natively");
  const make = (def: string) => new Function(`${runtime}\n${def}\nreturn { order: $String_order_go, chr: char_new };`)();
  const a = make(own), b = make(native);
  const rnd = lcg(3);
  const word = () => Array.from({ length: rnd(5) }, () => a.chr(codes[rnd(codes.length)])).join("");
  const cmps = [{ $: "LT" }, { $: "EQ" }, { $: "EQ" }, { $: "GT" }];
  for (let i = 0; i < 20000; i++) {
    const x = word(), y = rnd(4) === 0 ? x : word(), c = cmps[rnd(4)];
    expect(b.order(x, y, c).$).toBe(a.order(x, y, c).$);
  }
});

test("a String.order.go other than bend's own text is left alone and reported", () => {
  const helpers = "function char_len(s, at = 0) {\n}\nfunction char_code(s) {\n}\n";
  const odd = "function $String_order_go($0, $1, $2) {\n  return $2;\n}";
  const r = intrinsics(helpers + odd);
  expect(r.js).toBe(helpers + odd);
  expect(r.native).toEqual([]);
  expect(r.skipped.map((s) => s.name)).toEqual(["$String_order_go"]);
});

test("bend's own String.order.go without the runtime helpers it would call is left alone", () => {
  const own = defOf(bundle(new URL("./strings.bend", import.meta.url).pathname), "$String_order_go");
  const r = intrinsics(own);
  expect(r.js).toBe(own);
  expect(r.skipped.map((s) => s.reason)).toEqual(["the runtime's char_len(s, at) and char_code(s) are not in the module"]);
});

test("the built module carries the native String.order.go", () => {
  expect(readFileSync(new URL("./dist/strings.mjs", import.meta.url), "utf8")).toContain("// bend-emit: Base's String.order.go, natively");
});
