// Every identifier in a generated .mjs is either bend's own or starts with `be$`.
// bend's own are read from bend's raw output (the same compile build() starts
// from); bend never writes `be$`, so a name bend-emit adds cannot collide with
// one. A pass that adds a name without the prefix fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// The set difference above misses a name bend-emit adds when bend spells the
// same name (`s`, `r`, `i`, `x` are all bend's too). So the text bend-emit writes
// is read at its source: every name a JS literal in src/ *declares* (function
// and arrow parameters, const/let/var, class) must start with `be$`. A `${...}`
// interpolation is a name computed elsewhere and is skipped; the names bend
// itself spells (`_a_0`, `$String$cmp$`), which intrinsics.ts matches or
// replaces, are not bend-emit's.
const BEND_SPELLED = /^(?:_\w+_\d+|\$[\w$]*\$)$/;
// The string and template literals of a TypeScript source, comments and regex
// literals skipped; a `${...}` hole reads as `@` and its code is lexed in turn.
function literals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const code = (stop: boolean) => {
    let last = "", depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; continue; }
      if (c === '"' || c === "'") {
        const st = i++;
        while (src[i] !== c) i += src[i] === "\\" ? 2 : 1;
        i++; out.push(src.slice(st, i)); last = "x"; continue;
      }
      if (c === "`") { out.push("`" + tpl() + "`"); last = "x"; continue; }
      if (c === "/" && (last === "" || "(,=:!&|?{};".includes(last) || /\breturn$/.test(src.slice(Math.max(0, i - 7), i).trimEnd()))) {
        i++;
        for (let cls = false; src[i] !== "/" || cls; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false; }
        i++; last = "x"; continue;
      }
      if (stop) { if (c === "{") depth++; if (c === "}" && depth-- === 0) return; }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  };
  const tpl = (): string => {
    i++;
    let t = "";
    while (src[i] !== "`") {
      if (src[i] === "\\") { t += src.slice(i, i + 2); i += 2; }
      else if (src[i] === "$" && src[i + 1] === "{") { i += 2; code(true); i++; t += "@"; }
      else t += src[i++];
    }
    i++;
    return t;
  };
  code(false);
  return out;
}

export function declared(src: string): string[] {
  const lits = literals(src);
  const out: string[] = [];
  for (const lit of lits) {
    const t = lit.slice(1, -1);
    const list = (ps: string) => ps.split(",").map((p) => p.trim().replace(/\s*=.*$/, "")).filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
    for (const m of t.matchAll(/\b(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)) out.push(m[1]);
    for (const m of t.matchAll(/\bfunction\s*[\w$@]*\s*\(([^)]*)\)/g)) out.push(...list(m[1]));
    for (const m of t.matchAll(/\bconstructor\s*\(([^)]*)\)/g)) out.push(...list(m[1]));
    for (const m of t.matchAll(/\(([^()]*)\)\s*=>/g)) out.push(...list(m[1]));
    for (const m of t.matchAll(/(?<![\w$)])([A-Za-z_$][\w$]*)\s*=>/g)) out.push(m[1]);
    for (const m of t.matchAll(/\bfor\s*\((?:const|let|var)\s+([\w$]+)(?:\s*=\s*[^,;]+)?((?:\s*,\s*[\w$]+\s*=\s*[^,;]+)*)/g))
      out.push(m[1], ...[...m[2].matchAll(/,\s*([\w$]+)\s*=/g)].map((x) => x[1]));
  }
  return out.filter((n) => !n.startsWith("be$") && !BEND_SPELLED.test(n) && !JS_WORDS.has(n));
}

describe("names bend-emit's own text declares", () => {
  for (const f of ["loops", "classes", "strpeel", "intrinsics", "emit"]) {
    test(`src/${f}.ts declares only be$ names`, () => {
      expect(declared(readFileSync(fileURLToPath(new URL(`../src/${f}.ts`, import.meta.url)), "utf8"))).toEqual([]);
    });
  }
  test("the scan sees a bare parameter and a bare local", () => {
    expect(declared('`function ${name}(s, r) {`, "  const zz_stk = [];"')).toEqual(["s", "r", "zz_stk"]);
  });
});

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
