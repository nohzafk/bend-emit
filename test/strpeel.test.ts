// src/strpeel.ts: a string walk that only peels heads is carried as (string, index).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { peel } from "../src/strpeel";
import { first, nexts, tails } from "./dist/peel.mjs";
import type { BendList } from "./dist/peel.mjs";

// the text bend 2.0.38 emits for a string's head and tail, and its runtime's
// char_len: a packed non-scalar Char (U+DC00 and three units) is 4 units long
const HEAD = (p: string) => `${p}.slice(0, char_len(${p}))`;
const TAIL = (p: string) => `${p}.slice(char_len(${p}))`;
const RUNTIME = `function char_len(s, at = 0) {
  return s[at] === "\\uDC00" ? 4 : s.codePointAt(at) > 0xFFFF ? 2 : 1;
}`;

// the shape bend emits for `go(s, n, acc)` and a helper reading only a head
const reader = RUNTIME + "\n\n" + `function $cls$(_s_0) {
  if (_s_0 === "") {
    return 0;
  } else {
    const _c_0 = ${HEAD("_s_0")};
    return _c_0.length;
  }
}`;
const walker = (use: string) => `function $go$($0, $1, $2) {
  for (;;) {
    {
      const _s_0 = $0;
      const _n_0 = $1;
      const _acc_0 = $2;
      if (_s_0 === "") {
        return _acc_0;
      } else {
        const _c_0 = ${HEAD("_s_0")};
        const _t_0 = ${TAIL("_s_0")};
        $0 = _t_0;
        $1 = _n_0 + $cls$(_t_0);
        $2 = ${use};
        continue;
      }
    }
  }
}`;

test("a head-only walk carries an index and never slices the tail", () => {
  const src = reader + "\n\n" + walker("_acc_0 + _c_0");
  const r = peel(src);
  expect(r.kept).toEqual([]);
  expect(r.peeled.map((p) => p.kind).sort()).toEqual(["reader", "walker"]);
  expect(r.js).not.toContain(".slice(char_len(");
  expect(r.js).not.toContain(", char_len(_s_0))");
  const run = (js: string, s: string) => new Function(js + "; return [$go$($0s, 0, \"\"), $cls$];".replace("$0s", JSON.stringify(s)))();
  // same value as bend's own emission, on ascii, astral, packed and empty input
  const packed = "\uDC00\u0001\u0002\u0003";
  for (const s of ["", "a", "abc", "a😀b", "😀😀", "x😀", packed, "a" + packed + "😀", packed + packed]) {
    expect(run(r.js, s)[0]).toBe(run(src, s)[0]);
  }
  // the parameter a caller passes is still a plain string: the default index is 0
  expect(new Function(r.js + "; return $cls$(\"😀x\");")()).toBe(2);
});

test("the input is never copied: a 200k-char walk keeps the one string", () => {
  const r = peel(reader + "\n\n" + walker("_acc_0"));
  const f = new Function(r.js + "; return $go$;")();
  expect(f("a".repeat(200000), 0, "")).toBe("");
});

test("a tail used as a string is left as bend wrote it, and reported", () => {
  // the tail is concatenated: it has to exist as a string
  const src = reader + "\n\n" + walker("_acc_0 + _t_0");
  const r = peel(src);
  expect(r.kept.map((k) => k.name)).toEqual(["$go$"]);
  expect(r.js).toContain("_s_0.slice(char_len(_s_0))");
  expect(r.js).toContain("function $go$($0, $1, $2) {");
});

test("a tail passed to a def that uses it as a string is left alone", () => {
  const other = `function $len$(_s_0) {\n  return _s_0.length;\n}`;
  const src = other + "\n\n" + reader + "\n\n" + walker("$len$(_t_0)");
  const r = peel(src);
  expect(r.kept.map((k) => k.name)).toEqual(["$go$"]);
  expect(r.js).toContain("_s_0.slice(char_len(_s_0))");
});

test("a module without the runtime's char_len(s, at) is left as bend wrote it, and reported", () => {
  const src = (reader + "\n\n" + walker("_acc_0 + _c_0")).replace(RUNTIME, "");
  const r = peel(src);
  expect(r.js).toBe(src);
  expect(r.peeled).toEqual([]);
  expect(r.kept.map((k) => k.reason)).toEqual(["the runtime's char_len(s, at) is not in the module", "tail is used other than as the next step or a head-only reader's argument"]);
});

// test/peel.bend, as the gate built it: the pass reads the text this bend
// version emits, so a change in that text would leave it doing nothing, silently.
const fnText = (js: string, name: string) => js.slice(js.indexOf(`function ${name}(`), js.indexOf("\n}\n", js.indexOf(`function ${name}(`)));
const list = <T>(l: BendList<T>): T[] => {
  const out: T[] = [];
  for (; l.$ === "Con"; l = l.tail) out.push(l.head);
  return out;
};
const nil = { $: "Nil" } as const;
// Bend's reading of a host string: one Char per code point, a lone surrogate made U+FFFD.
const cps = (s: string) => [...s.replace(/\p{Cs}/gu, "\uFFFD")];

test("bend's own head-only walk and reader, built: both carry an index, and a kept tail stays a slice", () => {
  const js = readFileSync(new URL("./dist/peel.mjs", import.meta.url), "utf8");
  expect(fnText(js, "$first")).toStartWith("function $first(_s_0, be$i_s_0 = 0) {");
  expect(fnText(js, "$nexts")).toStartWith("function $nexts($0, $1, be$i$0 = 0) {");
  for (const f of ["$first", "$nexts"]) expect(fnText(js, f)).not.toContain(".slice(char_len(");
  expect(fnText(js, "$tails")).toStartWith("function $tails($0, $1) {");
  expect(fnText(js, "$tails")).toContain(".slice(char_len(_s_0))");
});

test("the built walk and reader give Base's values, on ascii, astral and lone surrogates", () => {
  for (const s of ["", "a", "abc", "a😀b", "😀😀", "x\ud800y", "\udc00", "é😀\uffff"]) {
    const c = cps(s);
    expect(first(s)).toBe(c.length ? c[0].codePointAt(0)! : 0);
    // nexts prepends first(t) for each tail t, the shortest last
    const want = c.map((_, i) => (i + 1 < c.length ? c[i + 1].codePointAt(0)! : 0)).reverse();
    expect(list(nexts(s, nil))).toEqual(want);
    expect(list(tails(s, nil))).toEqual(c.map((_, i) => c.slice(i + 1).join("")).reverse());
  }
  expect(list(nexts("a".repeat(200000), nil)).length).toBe(200000);
});
