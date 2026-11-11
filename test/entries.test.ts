import { expect, test } from "bun:test";
import { entries } from "../src/entries";

const prog = (body: string) => `function run_loop(r) { return r; }\n${body}\nconst be$default = {};\n`;

test("a call through a plain entry is written back as bend 2.0.39's direct call, and the entry goes", () => {
  const js = prog([
    "function $f(_n_0) {",
    "  return $g($$f(_n_0), $$h(\"a)\", [1, (2)]));",
    "}",
    "const $$f = $f;",
    "const $$h = $h;",
  ].join("\n"));
  const r = entries(js);
  expect(r.kept).toEqual([]);
  expect(r.js).toContain('return $g(($f(_n_0)), ($h("a)", [1, (2)])));');
  expect(r.js).not.toContain("$$");
});

test("a call through a jumping entry runs its loop, as bend 2.0.39 wrote it", () => {
  const js = prog("function $f(a, b) {\n  return $k($$f(a, b));\n}\nconst $$f = (a0,a1) => run_loop($f(a0,a1));");
  const r = entries(js);
  expect(r.kept).toEqual([]);
  expect(r.js).toContain("return $k(run_loop($f(a, b)));");
  expect(r.js).not.toContain("$$");
});

test("a call nested in another's arguments is written too", () => {
  const js = prog("function $f(x) {\n  return $$f($$f($$f(x)), $$f(x));\n}\nconst $$f = $f;");
  const r = entries(js);
  expect(r.js).toContain("return ($f(($f(($f(x)))), ($f(x))));");
  expect(r.js).not.toContain("$$");
});

test("the entry followed by export default on the same line leaves export default at the start of its line", () => {
  const r = entries("function $f() {\n  return $$f();\n}\nconst $$f = $f;export default {\n};\n");
  expect(r.js).toMatch(/^export default \{$/m);
});

test("an entry used other than as a callee keeps its definition, and is reported", () => {
  const js = prog("function $f(x) {\n  return [$$f, $$f(x)];\n}\nconst $$f = $f;");
  const r = entries(js);
  expect(r.kept).toEqual([{ name: "$$f", reason: "used other than as the callee of a call" }]);
  expect(r.js).toContain("return [$$f, ($f(x))];");
  expect(r.js).toContain("const $$f = $f;");
});

test("an entry of another shape is left alone, and is reported", () => {
  const js = prog("function $f(x) {\n  return $$f(x);\n}\nconst $$f = $other;");
  const r = entries(js);
  expect(r.kept).toEqual([{ name: "$$f", reason: "an entry of a shape this bend version does not write" }]);
  expect(r.js).toBe(js);
});

test("a name that ends in another entry's name is not taken for it", () => {
  const js = prog("function $f(x) {\n  return $a$$f(x) + $$f(x);\n}\nconst $$f = $f;");
  const r = entries(js);
  expect(r.js).toContain("return $a$$f(x) + ($f(x));");
});
