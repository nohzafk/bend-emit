// Every identifier in a generated .mjs is either bend's own or starts with `be$`.
// bend's own are read from bend's raw output (the same compile build() starts
// from); bend never writes `be$`, so a name bend-emit adds cannot collide with
// one. A pass that adds a name without the prefix fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bundle } from "../src/emit";

const FIXTURES = ["generics", "uses", "reuses", "templated", "dependent", "dependent_user", "chars", "maps", "strings", "runtime_names"];

// Identifiers outside string literals and `//` comments.
function idents(js: string): Set<string> {
  const noStr = js.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const noCom = noStr.replace(/\/\/[^\n]*/g, "");
  const out = new Set(noCom.match(/(?<![\w$])[A-Za-z_$][\w$]*/g) ?? []);
  // a quoted key ("fst": ...) becomes a member name (this.fst) in a class, and a
  // tag "mod.Ctor" loses its module path
  for (const m of js.matchAll(/"([\w$./]+)"/g)) for (const w of m[1].split(/[./]/)) if (/^[A-Za-z_$]/.test(w)) out.add(w);
  return out;
}

// What bend-emit's own text may use without a prefix: JavaScript's words and the
// members it calls. Anything else it adds must start with `be$`.
const JS_WORDS = new Set([
  "const", "let", "var", "function", "class", "constructor", "this", "new", "return", "for", "while", "if", "else",
  "break", "continue", "export", "default", "as", "true", "false", "null", "undefined", "typeof", "void",
  "pop", "push", "length", "slice", "codePointAt",
]);

describe("names in the generated .mjs", () => {
  for (const f of FIXTURES) {
    test(`${f}: bend never writes be$, and bend-emit adds only be$ names`, () => {
      const raw = idents(bundle(`test/${f}.bend`));
      expect([...raw].filter((n) => n.startsWith("be$"))).toEqual([]);
      const text = readFileSync(new URL(`./dist/${f}.mjs`, import.meta.url), "utf8");
      // `export { be$0 as name }`: the exported names are the user's own (D3)
      const built = idents(text.replace(/^export \{[^}]*\};$/m, ""));
      const added = [...built].filter((n) => !raw.has(n) && !JS_WORDS.has(n));
      expect(added.filter((n) => !n.startsWith("be$"))).toEqual([]);
      // the top-level declarations bend-emit adds are among them
      const top = [...text.matchAll(/^(?:function|class|const|let|var) ([\w$]+)/gm)].map((m) => m[1]);
      expect(top.filter((n) => !raw.has(n) && !n.startsWith("be$"))).toEqual([]);
    });
  }
});
