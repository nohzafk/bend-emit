// src/strpeel.ts: a string walk that only peels heads is carried as (string, index).
import { expect, test } from "bun:test";
import { peel } from "../src/strpeel";

const HEAD = (p: string) => `(${p}.codePointAt(0) > 0xFFFF ? ${p}.slice(0, 2) : ${p}[0])`;
const TAIL = (p: string) => `(${p}.codePointAt(0) > 0xFFFF ? ${p}.slice(2) : ${p}.slice(1))`;

// the shape bend emits for `go(s, n, acc)` and a helper reading only a head
const reader = `function $cls$(_s_0) {
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
  expect(r.js).not.toContain(".slice(1)");
  expect(r.js).not.toContain(".slice(2)");
  const run = (js: string, s: string) => new Function(js + "; return [$go$($0s, 0, \"\"), $cls$];".replace("$0s", JSON.stringify(s)))();
  // same value as bend's own emission, on ascii, astral and empty input
  for (const s of ["", "a", "abc", "a😀b", "😀😀", "x😀"]) {
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
  expect(r.js).toContain(".slice(1)");
  expect(r.js).toContain("function $go$($0, $1, $2) {");
});

test("a tail passed to a def that uses it as a string is left alone", () => {
  const other = `function $len$(_s_0) {\n  return _s_0.length;\n}`;
  const src = other + "\n\n" + reader + "\n\n" + walker("$len$(_t_0)");
  const r = peel(src);
  expect(r.kept.map((k) => k.name)).toEqual(["$go$"]);
  expect(r.js).toContain(".slice(1)");
});
