// src/select.ts: a call to a selector def evaluates only the chosen argument,
// and the recursion around it is still a loop. test.sh builds dist/ first.
import { expect, test } from "bun:test";
import { find, guarded, len, pick_m, pick_nat, type BendList } from "./dist/select.mjs";
import { lazySelect } from "../src/select";
import { loopify } from "../src/loops";

const list = (n: number): BendList<number> => {
  let l: BendList<number> = { $: "Nil" };
  for (let i = 0; i < n; i++) l = { $: "Con", head: 1, tail: l };
  return l;
};
const cases = (tags: number[]) => {
  let c: any = { $: "NoCase" };
  for (let i = tags.length - 1; i >= 0; i--) c = { $: "Case", tag: tags[i], next: c };
  return c;
};
const DEEP = 100_000;

test("the selector stays callable", () => {
  expect(pick_nat(true, 1, 2)).toBe(1);
  expect(pick_nat(false, 1, 2)).toBe(2);
  expect(pick_m(false, "a", "b")).toBe("b");
});

test("only the chosen argument is evaluated", () => {
  // The other arm would throw on its first step.
  const top = 2 ** 48 - 1;
  expect(guarded(true, list(3), top)).toBe(0);
  expect(() => guarded(false, list(3), top)).toThrow();
});

test("a self-call under a selector is still a loop, 100k deep", () => {
  expect(len(list(DEEP), 0)).toBe(DEEP);
  const tags = Array.from({ length: DEEP }, (_, i) => i);
  expect(find(cases(tags), DEEP - 1, 0)).toBe(DEEP - 1);
  expect(find(cases(tags), 7, 0)).toBe(7);
  expect(find(cases([1, 2]), 9, 0)).toBe(0);
});

const SEL = `function $pick$(_b_0, _x_0, _y_0) {\n  if (_b_0) {\n    return _x_0;\n  } else {\n    return _y_0;\n  }\n}\n\n`;
const fn = (body: string) => SEL + `function $f$(_n_0, _m_0) {\n${body}\n}`;

test("recognition is structural: only if (b) return p else return q", () => {
  const other = `function $g$(_b_0, _x_0, _y_0) {\n  if (_b_0) {\n    return _x_0;\n  } else {\n    return ($h$(_y_0));\n  }\n}\n\nfunction $f$(_n_0) {\n  return $g$(_n_0, $f$(_n_0), 1);\n}`;
  expect(lazySelect(other).rewritten).toBe(0);
  const same = `function $g$(_b_0, _x_0, _y_0) {\n  if (_b_0) {\n    return _b_0;\n  } else {\n    return _y_0;\n  }\n}\n\nfunction $f$(_n_0) {\n  return $g$(_n_0, 1, 2);\n}`;
  expect(lazySelect(same).rewritten).toBe(0);
});

test("a call that is all of a return becomes an if; nested ones nest", () => {
  const r = lazySelect(fn(`  return $pick$(_n_0, $f$(_m_0, 1), $pick$(_m_0, 2, 3));`));
  expect(r.rewritten).toBe(2);
  expect(r.js).toContain("if (_n_0) {");
  expect(r.js).toContain("return $f$(_m_0, 1);");
  expect(r.js).toContain("if (_m_0) {");
});

test("elsewhere it becomes a conditional, unless it holds a self-call", () => {
  const a = lazySelect(fn(`  return [$pick$(_n_0, 1, 2)];`));
  expect(a.js).toContain("[(_n_0 ? 1 : 2)]");
  const b = lazySelect(fn(`  return [$pick$(_n_0, $f$(_m_0, 1), 2)];`));
  expect(b.rewritten).toBe(0);
});

test("a selector used as a value is left alone", () => {
  const r = lazySelect(fn(`  return [$pick$, $pick$(_n_0, 1)];`));
  expect(r.rewritten).toBe(0);
});

test("the rewritten def loops (no stay), where a ?: would not", () => {
  const r = loopify(lazySelect(fn(`  if (_n_0 === 0) {\n    return 0;\n  } else {\n    return $pick$(_m_0, $f$(_n_0 - 1, _m_0), $f$(_n_0 - 1, _m_0));\n  }`)).js);
  expect(r.stayed).toEqual([]);
  const f = new Function(r.js + "; return $f$;")();
  expect(f(DEEP, true)).toBe(0);
});
