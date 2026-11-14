// src/lazy.ts: a call runs only on the paths that read its result, and the
// recursion around it is still a loop. test.sh builds dist/ first.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { all_are, and_len, count, dotted, has, or_len, put, search, search_near, search_on, type BendList } from "./dist/lazy.mjs";
import { lazyArgs } from "../src/lazy";
import { loopify } from "../src/loops";

const list = (xs: number[]): BendList<number> => {
  let l: BendList<number> = { $: "Nil" };
  for (let i = xs.length - 1; i >= 0; i--) l = { $: "Con", head: xs[i], tail: l };
  return l;
};
const ones = (n: number) => list(Array.from({ length: n }, () => 1));
const DEEP = 100_000;
// The largest Nat bend holds: one step past it throws.
const TOP = 2 ** 48 - 1;

test("the helper stays callable", () => {
  expect(put(true, 3, { $: "Miss", seen: 0 })).toEqual({ $: "Hit", at: 3 });
  expect(put(false, 3, { $: "Miss", seen: 9 })).toEqual({ $: "Miss", seen: 9 });
});

test("a search stops at its first hit", () => {
  // Searching the tail would count one past TOP, and throw.
  expect(search(list([5, 6, 7]), 5, TOP)).toEqual({ $: "Hit", at: TOP });
  expect(() => search(list([5, 6, 7]), 6, TOP)).toThrow();
  expect(search(list([5, 6, 7]), 7, 0)).toEqual({ $: "Hit", at: 2 });
  expect(search(list([5, 6, 7]), 8, 0)).toEqual({ $: "Miss", seen: 3 });
});

test("a helper that hands its arguments on is as lazy as the one it calls", () => {
  expect(search_on(list([5, 6, 7]), 5, TOP)).toEqual({ $: "Hit", at: TOP });
  expect(search_on(list([5, 6, 7]), 8, 0)).toEqual({ $: "Miss", seen: 3 });
});

test("a helper that binds names of its own is placed with those names renamed", () => {
  expect(search_near(list([5, 6, 7]), 5, TOP)).toEqual({ $: "Hit", at: TOP });
  expect(search_near(list([5, 6, 7]), 7, 0)).toEqual({ $: "Hit", at: 2 });
  expect(search_near(ones(DEEP), 2, 0)).toEqual({ $: "Miss", seen: DEEP });
  const js = readFileSync(new URL("./dist/lazy.mjs", import.meta.url), "utf8");
  expect(js).toContain("be$in1_at_0");
});

test("Bool.or and Bool.and run their right side only when the left does not decide", () => {
  expect(or_len(true, list([1]), TOP)).toBe(true);
  expect(() => or_len(false, list([1]), TOP)).toThrow();
  expect(and_len(false, list([1]), TOP)).toBe(false);
  expect(() => and_len(true, list([1]), TOP)).toThrow();
  expect(or_len(false, list([]), 0)).toBe(true);
  expect(and_len(true, list([1]), 0)).toBe(false);
});

test("the recursion is still a loop, 100k deep", () => {
  expect(search(ones(DEEP), 2, 0)).toEqual({ $: "Miss", seen: DEEP });
  expect(search_on(ones(DEEP), 2, 0)).toEqual({ $: "Miss", seen: DEEP });
  expect(has(2, ones(DEEP))).toBe(false);
  expect(has(1, ones(DEEP))).toBe(true);
  expect(all_are(1, ones(DEEP))).toBe(true);
  expect(all_are(2, ones(DEEP))).toBe(false);
  // tally matches on the rest: count is left as bend wrote it, and loops as before.
  expect(count(ones(DEEP))).toEqual({ $: "Miss", seen: DEEP });
});

test("the built module calls no helper where its body now stands", () => {
  const js = readFileSync(new URL("./dist/lazy.mjs", import.meta.url), "utf8");
  const def = (name: string) => js.slice(js.indexOf(`function $${name}(`), js.indexOf("\n}\n", js.indexOf(`function $${name}(`)));
  expect(def("search")).not.toContain("$put(");
  expect(def("search_on")).not.toContain("$put");
  expect(def("all_are")).not.toContain("$Bool_and(");
  expect(def("has")).not.toContain("||");
  expect(def("count")).toContain("$tally(");
});

// ---------------------------------------------------------------------------
// The text

const fn = (name: string, ps: string, body: string) => `function ${name}(${ps}) {\n${body}\n}`;
const PUT = fn("$put", "_ok_0, _h_0, _r_0", `  if (_ok_0) {\n    return {$: "Got", "c": _h_0};\n  } else {\n    return $cons(_h_0, _r_0);\n  }`);
const walk = (ret: string) =>
  fn("$f", "_xs_0", `  if (_xs_0.$ === "Nil") {\n    return {$: "Got", "c": 0};\n  } else {\n    const _h_0 = _xs_0["head"];\n    const _t_0 = _xs_0["tail"];\n    ${ret}\n  }`);

test("inline: the helper's body stands at the return, and the unread call is gone from the other path", () => {
  const src = PUT + "\n\n" + walk(`return $put(($ready(_h_0)), _h_0, ($f(_t_0)));`);
  const r = lazyArgs(src);
  expect(r.inlined).toBe(1);
  expect(r.js).toContain(`    if (($ready(_h_0))) {\n      return {$: "Got", "c": _h_0};\n    } else {\n      return $cons(_h_0, ($f(_t_0)));\n    }`);
  expect(r.js).toContain(PUT);
  // The same value, with one test where there were three.
  const run = (js: string) => {
    const m = new Function(`let n = 0; const $ready = (h) => (n++, h === 1); const $cons = (h, r) => ({$: "Got", "c": h + r["c"]});\n${js}\nreturn { f: $f, n: () => n };`)();
    return [m.f(list([1, 2, 3])), m.n()];
  };
  expect(run(src)).toEqual([{ $: "Got", c: 1 }, 3]);
  expect(run(r.js)).toEqual([{ $: "Got", c: 1 }, 1]);
});

test("inline: the helper's locals are renamed, the caller's names are not captured", () => {
  const pick = fn("$pick", "_ok_0, _p_0, _r_0", `  if (_ok_0) {\n    const _h_0 = _p_0["x"];\n    return _h_0;\n  } else {\n    return _r_0;\n  }`);
  const g = (body: string) => fn("$g", "_h_0, _q_0", body);
  const r = lazyArgs(pick + "\n\n" + g(`  return $pick(_q_0, _h_0, ($slow(_h_0)));`));
  expect(r.js).toContain(g(`  if (_q_0) {\n    const be$in1_h_0 = _h_0["x"];\n    return be$in1_h_0;\n  } else {\n    return ($slow(_h_0));\n  }`));
  // A caller that already holds the name the local would take is left alone.
  const taken = pick + "\n\n" + g(`  const be$in1_h_0 = _q_0;\n  return $pick(be$in1_h_0, _h_0, ($slow(_h_0)));`);
  expect(lazyArgs(taken).js).toBe(taken);
});

test("inline: only for a call in a position some path of the helper does not read", () => {
  const cons = fn("$cons", "_h_0, _r_0", `  const _c_0 = _r_0["c"];\n  return {$: "Got", "c": (_h_0 + _c_0)};`);
  for (const ret of [`return $put(_h_0, _h_0, _t_0);`, `return $put(($ready(_h_0)), _h_0, _t_0);`, `return $cons(_h_0, ($f(_t_0)));`, `return [$put(_h_0, _h_0, ($f(_t_0)))];`]) {
    const src = PUT + "\n\n" + cons + "\n\n" + walk(ret);
    const r = lazyArgs(src);
    expect(r.js).toBe(src);
    expect(r.inlined).toBe(0);
  }
});

test("inline: a helper that hands a parameter on where its callee is lazy is lazy there too", () => {
  const on = fn("$put_on", "_a_0, _b_0, _c_0", `  return $put(_a_0, _b_0, _c_0);`);
  const r = lazyArgs(PUT + "\n\n" + on + "\n\n" + walk(`return $put_on(($ready(_h_0)), _h_0, ($f(_t_0)));`));
  expect(r.inlined).toBe(2);
  expect(r.js).toContain(`      return $cons(_h_0, ($f(_t_0)));`);
  expect(r.js).not.toContain(`return $put_on(($ready`);
});

test("a def with a closure, or a line of another shape, is left alone and never inlined", () => {
  const clo = fn("$put", "_ok_0, _h_0, _r_0", `  if (_ok_0) {\n    return (_x_0) => {\n      return _h_0;\n    }\n  } else {\n    return _r_0;\n  }`);
  const a = clo + "\n\n" + walk(`return $put(($ready(_h_0)), _h_0, ($f(_t_0)));`);
  expect(lazyArgs(a).js).toBe(a);
  const sw = fn("$g", "_a_0", `  let $pc = 0;\n  for (;;) switch ($pc) {\n    case 0: {\n      const _x_0 = ($slow(_a_0));\n      return (_a_0 || _x_0);\n    }\n  }`);
  expect(lazyArgs(sw).js).toBe(sw);
});

const mem = (tail: string) =>
  fn("$mem", "_k_0, _ks_0", `  if (_ks_0.$ === "Nil") {\n    return false;\n  } else {\n    const _h_0 = _ks_0["head"];\n    const _t_0 = _ks_0["tail"];\n${tail}\n  }`);

test("lift: Bool.or as bend writes it becomes an if, its right side the last thing returned", () => {
  const r = lazyArgs(mem(`    const _x_0 = (_k_0 === _h_0);\n    const _x_1 = ($mem(_k_0, _t_0));\n    return (_x_0 || _x_1);`));
  expect(r.js).toBe(mem(`    const _x_0 = (_k_0 === _h_0);\n    if (_x_0) {\n      return _x_0;\n    } else {\n      return ($mem(_k_0, _t_0));\n    }`));
  const l = loopify(r.js);
  expect(l.stayed).toEqual([]);
  const f = new Function(l.js + "; return $mem;")();
  expect(f(2, ones(DEEP))).toBe(false);
  expect(f(1, ones(DEEP))).toBe(true);
});

test("lift: && the same way; a right side that costs nothing stays", () => {
  const r = lazyArgs(mem(`    const _x_1 = ($mem(_k_0, _t_0));\n    return (_h_0 && _x_1);`));
  expect(r.js).toBe(mem(`    if (_h_0) {\n      return ($mem(_k_0, _t_0));\n    } else {\n      return _h_0;\n    }`));
  const plain = mem(`    return (_h_0 || _t_0);`);
  expect(lazyArgs(plain).js).toBe(plain);
  const tern = mem(`    const _x_1 = ($mem(_k_0, _t_0));\n    return (_h_0 || _x_1 ? 1 : 2);`);
  expect(lazyArgs(tern).js).toBe(tern);
});

test("lift: a const that only reads such a const moves with it", () => {
  const r = lazyArgs(fn("$any", "_n_0, _a_0", `  const _l_0 = _n_0["l"];\n  const _r_0 = _n_0["r"];\n  const _x_1 = ($any(_l_0, _a_0));\n  const _x_2 = ($any(_r_0, _a_0));\n  const _x_4 = (_x_1 || _x_2);\n  return (_a_0 || _x_4);`));
  expect(r.js).toBe(fn("$any", "_n_0, _a_0", `  const _l_0 = _n_0["l"];\n  const _r_0 = _n_0["r"];\n  if (_a_0) {\n    return _a_0;\n  } else {\n    const _x_1 = ($any(_l_0, _a_0));\n    if (_x_1) {\n      return _x_1;\n    } else {\n      return ($any(_r_0, _a_0));\n    }\n  }`));
});

const g = (body: string) => fn("$g", "_a_0, _b_0", body);

test("sink: a const moves into the arms that read it", () => {
  const r = lazyArgs(g(`  const _x_0 = ($slow(_b_0));\n  if (_a_0) {\n    return 0;\n  } else if (_b_0) {\n    return (_x_0 + 1);\n  } else {\n    return 2;\n  }`));
  expect(r.js).toBe(g(`  if (_a_0) {\n    return 0;\n  } else if (_b_0) {\n    const _x_0 = ($slow(_b_0));\n    return (_x_0 + 1);\n  } else {\n    return 2;\n  }`));
  expect(r.sunk).toBe(1);
});

test("sink: not past a condition that reads it, a later reader, an assignment, or a const it would shadow", () => {
  for (const body of [
    `  const _x_0 = ($slow(_b_0));\n  if (_x_0.$ === "A") {\n    return 0;\n  } else {\n    return _x_0;\n  }`,
    `  const _x_0 = ($slow(_b_0));\n  if (_a_0) {\n    return 0;\n  } else if (_x_0) {\n    return 1;\n  } else {\n    return 2;\n  }`,
    `  const _x_0 = ($slow(_b_0));\n  if (_a_0) {\n    return 0;\n  }\n  return _x_0;`,
    `  const _x_0 = ($slow(_b_0));\n  _b_0 = _a_0;\n  if (_a_0) {\n    return 0;\n  } else {\n    return _x_0;\n  }`,
    `  const _x_0 = ($slow(_y_0));\n  if (_a_0) {\n    return 0;\n  } else {\n    const _y_0 = _b_0;\n    return (_x_0 + _y_0);\n  }`,
    `  const _x_0 = (_b_0 + 1);\n  if (_a_0) {\n    return 0;\n  } else {\n    return _x_0;\n  }`,
  ]) {
    expect(lazyArgs(g(body)).js).toBe(g(body));
  }
});

test("fold: a const read once under || is written there, unless it is a self-call", () => {
  const r = lazyArgs(g(`  const _x_0 = ($slow(_b_0));\n  const _x_1 = (_a_0 || _x_0);\n  return $use(_x_1, _a_0);`));
  expect(r.js).toBe(g(`  const _x_1 = (_a_0 || ($slow(_b_0)));\n  return $use(_x_1, _a_0);`));
  const self = g(`  const _x_0 = ($g(_b_0, _a_0));\n  const _x_1 = (_a_0 || _x_0);\n  return $use(_x_1, _a_0);`);
  expect(lazyArgs(self).js).toBe(self);
  const twice = g(`  const _x_0 = ($slow(_b_0));\n  const _x_1 = (_a_0 || _x_0);\n  return $use(_x_1, _x_0);`);
  expect(lazyArgs(twice).js).toBe(twice);
});

test("a def that was a loop stays one: a rewrite loops.ts could not loop is dropped", () => {
  const last = fn("$last", "_r_0, _d_0", `  if (_r_0.$ === "None") {\n    return _d_0;\n  } else {\n    return _r_0;\n  }`);
  const f = fn("$f", "_xs_0", `  if (_xs_0.$ === "Nil") {\n    return {$: "None"};\n  } else {\n    const _t_0 = _xs_0["tail"];\n    return $last(($f(_t_0)), ($slow(_xs_0)));\n  }`);
  const src = last + "\n\n" + f;
  const r = lazyArgs(src);
  expect(r.js).toBe(src);
  expect(r.reverted).toEqual([{ name: "$f", reason: "the rewrite would leave it a recursion" }]);
  expect(r.inlined).toBe(0);
  // Without the guard the self-call is bound before an `if`, where it is no loop step.
  const u = lazyArgs(src, false);
  expect(u.js).toContain(`const be$arg1_0 = ($f(_t_0));\n    if (be$arg1_0.$ === "None") {`);
  expect(loopify(src).stayed).toEqual([]);
  expect(loopify(u.js).stayed.map((s) => s.name)).toEqual(["$f"]);
});

test("a string that looks like code is not read as code", () => {
  const src = PUT + "\n\n" + fn("$g", "_a_0, _b_0", `  const _x_0 = "_a_0 || $f(1)";\n  return $put(_a_0, _x_0, "($f(_b_0)) || $g(");`);
  expect(lazyArgs(src).js).toBe(src);
});

test("a string walk stays an index walk: a head-only reader is not placed in it", () => {
  expect(dotted("ab.c", 5)).toBe(99);
  expect(dotted("ab.", 5)).toBe(6);
  expect(dotted("abc", 5)).toBe(0);
  expect(dotted("é😀.😀", 0)).toBe(0x1f600);
  const js = readFileSync(new URL("./dist/lazy.mjs", import.meta.url), "utf8");
  const head = js.slice(js.indexOf("function $dotted("), js.indexOf("\n", js.indexOf("function $dotted(")));
  expect(head).toContain("be$i");
  expect(js.slice(js.indexOf("function $dotted("))).toContain("$after_dot(");
});

const run = (js: string, name: string, ...args: unknown[]) => new Function(`const $slow = () => 9;\n${js}\nreturn ${name};`)()(...args);

test("inline: not a helper that declares a parameter's name again, or reads a name before its declaration", () => {
  const h = fn("$h", "_p_0, _ok_0, _r_0", `  if (_ok_0) {\n    const _p_0 = 7;\n    return _p_0;\n  } else {\n    return _p_0;\n  }`);
  const src = h + "\n\n" + fn("$f", "_p_0, _ok_0", `  return $h(_p_0, _ok_0, $slow());`);
  expect(lazyArgs(src).js).toBe(src);
  expect(run(src, "$f", 3, false)).toBe(3);
  const twice = fn("$h", "_a_0, _ok_0, _r_0", `  const _x_0 = _a_0;\n  if (_ok_0) {\n    const _x_0 = 7;\n    return _x_0;\n  } else {\n    return (_x_0 + _r_0);\n  }`);
  const src2 = twice + "\n\n" + fn("$f", "_p_0, _ok_0", `  return $h(_p_0, _ok_0, $slow());`);
  expect(lazyArgs(src2).js).toBe(src2);
});

test("inline: not into a def that binds a name the helper reads from the module", () => {
  const value = fn("$value", "", `  return 3;`);
  const h = fn("$h", "_ok_0, _r_0", `  if (_ok_0) {\n    return $value();\n  } else {\n    return _r_0;\n  }`);
  const src = value + "\n\n" + h + "\n\n" + fn("$f", "$value", `  return $h(true, $slow());`);
  expect(lazyArgs(src).js).toBe(src);
  expect(run(src, "$f", () => 4)).toBe(3);
});

test("fold: a number written where a name stood is not read as a fraction", () => {
  const h = fn("$h", "_p_0, _ok_0, _r_0", `  if (_ok_0) {\n    return _p_0.toString();\n  } else {\n    return _r_0;\n  }`);
  const src = h + "\n\n" + fn("$f", "_ok_0", `  return $h(1, _ok_0, $slow());`);
  const r = lazyArgs(src);
  expect(r.inlined).toBe(1);
  expect(r.js).toContain("return (1).toString();");
  expect(run(r.js, "$f", true)).toBe("1");
  expect(run(r.js, "$f", false)).toBe(9);
});

test("a line that holds more than one statement is no known shape", () => {
  const src = fn("$f", "_b_0", `  const _x_0 = $slow(); debugger;\n  if (_b_0) {\n    return 0;\n  } else {\n    return _x_0;\n  }`);
  expect(lazyArgs(src).js).toBe(src);
  const open = fn("$f", "_b_0", `  const _x_0 = $slow()); (0;\n  if (_b_0) {\n    return 0;\n  } else {\n    return _x_0;\n  }`);
  expect(lazyArgs(open).js).toBe(open);
});

test("inline: a parameter a later condition of the helper tests is read on every path", () => {
  const h = fn("$h", "_b_0, _r_0", `  if (_b_0) {\n    return _r_0;\n  } else if (_r_0) {\n    return 1;\n  } else {\n    return 0;\n  }`);
  const src = h + "\n\n" + fn("$f", "_b_0", `  return $h(_b_0, $slow());`);
  const r = lazyArgs(src);
  expect(r.js).toBe(src);
  expect(r.inlined).toBe(0);
});

test("a long chain of consts settles in one run", () => {
  const N = 300;
  const chain = Array.from({ length: N }, (_, i) => `  const _x${i + 1} = _x${i};`).join("\n");
  const src = fn("$f", "_b_0", `  const _x0 = $slow();\n${chain}\n  return (_b_0 || _x${N});`);
  const r = lazyArgs(src);
  expect(r.js.indexOf("$slow()")).toBeGreaterThan(r.js.indexOf("if (_b_0) {"));
  expect(lazyArgs(r.js).js).toBe(r.js);
  expect(run(r.js, "$f", false)).toBe(9);
});
