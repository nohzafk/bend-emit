// Base's String comparison, as bend 2.0.38 emits it: the order bend-emit's
// hosts rely on, at any length, beside defs named like bend-emit's helpers.
// (Through 2.0.37 bend-emit put a native String.cmp in its place; see git log.)
import { expect, test } from "bun:test";
import { count_eq, s_eq, s_gt, s_lt, str_order, unwind } from "./dist/strings.mjs";

// Bend's reading of a JS string: one Char per step (a code point above U+FFFF
// is two units; a lone surrogate is one).
function chars(s: string): number[] {
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

const pool = ["", "a", "b", "ab", "ba", "aa", "\u00e9", "\ue000", "\uffff", "\u{1f600}", "\u{10000}", "\ud800", "\udc00", "\ud800x", "x\udc00", "\u{1f600}a"];

test("order equals Base's, including astral and lone surrogates", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
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
