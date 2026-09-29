// src/loops.ts: which recursive defs become loops, and which stay recursion.
import { expect, test } from "bun:test";
import { loopify } from "../src/loops";

const fn = (name: string, body: string) => `function ${name}(_s_0) {\n${body}\n}`;
const stays = (name: string, body: string) => {
  const src = fn(name, body);
  const r = loopify(src);
  expect(r.js).toBe(src);
  expect(r.stayed.map((s) => s.name)).toEqual([name]);
};

const head = `  if (_s_0.$ === "Nil") {\n    return {$: "Nil"};\n  } else {\n    const _t_0 = _s_0["tail"];\n`;

test("last-field self-call becomes a loop, and folds in order", () => {
  const r = loopify(fn("$f$", head + `    return {$: "Con", "head": (_s_0["head"] + 1), "tail": ($f$(_t_0))};\n  }`));
  expect(r.stayed).toEqual([]);
  expect(r.js).toContain("for (;;)");
  const mod = new Function(r.js + "; return $f$;")();
  let l: any = { $: "Nil" };
  for (let i = 0; i < 300000; i++) l = { $: "Con", head: i, tail: l };
  let o = mod(l), n = 0;
  for (; o.$ === "Con"; o = o.tail) n++;
  expect(n).toBe(300000);
});
test("non-final field", () => stays("$f$", head + `    return {$: "P", "a": ($f$(_t_0)), "b": 1};\n  }`));
test("two recursive fields", () => stays("$f$", head + `    return {$: "P", "a": ($f$(_t_0)), "b": ($f$(_t_0))};\n  }`));
test("inside another call", () => stays("$f$", head + `    return {$: "P", "a": 1, "b": ($g$(($f$(_t_0))))};\n  }`));
test("scrutinee", () => stays("$f$", head + `    const _r = $f$(_t_0);\n    if (_r.$ === "Nil") {\n      return {$: "Nil"};\n    } else {\n      return {$: "Con", "head": 1, "tail": _r};\n    }\n  }`));
test("mixed with a tail call", () => stays("$f$", `  for (;;) {\n    if (_s_0.$ === "Nil") {\n      return {$: "Nil"};\n    }\n    return {$: "Con", "head": 1, "tail": ($f$(_s_0["tail"]))};\n  }`));
test("own name as a value", () => stays("$f$", head + `    return {$: "Con", "head": $f$, "tail": ($f$(_t_0))};\n  }`));
