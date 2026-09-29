// loops.ts: turn shape (B) recursion in bend's emitted JavaScript into a loop.
//
// bend's own backend already turns a tail self-call (shape A) into `for (;;)`.
// It leaves a constructor whose LAST field is the self-call (shape B):
//
//   return {$: "TCon", "k": (E), "rest": ($tokens$(A))};
//
// which needs one JavaScript frame per step. This pass rewrites such a def:
// each recursive leaf builds the constructor with the last field left null,
// pushes it (with the field's name) on a stack, rebinds the parameters and
// continues; each other `return X;` folds the stack back into X, innermost
// first. The other fields are evaluated once, in source order, before the
// arguments of the call, as in the recursion.
//
// Conservative: a def is rewritten only if EVERY occurrence of its own name in
// its body is the last field of a single-line `return {$: ...};`, and the body
// has nothing this pass does not model (a nested function, a loop, a $JMP).
// Anything else is left as bend wrote it, and reported.

export interface Stayed { name: string; reason: string }

// Index of the bracket closing the one opened at s[i], skipping JS strings; -1 if none.
function close(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (j++; j < s.length && s[j] !== ch; j++) if (s[j] === "\\") j++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") { if (--d === 0) return j; if (d < 0) return -1; }
  }
  return -1;
}

// Split on commas outside brackets and strings.
function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0, cur = "";
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      const st = j;
      for (j++; j < s.length && s[j] !== ch; j++) if (s[j] === "\\") j++;
      cur += s.slice(st, j + 1);
      continue;
    }
    if ("({[".includes(ch)) d++;
    if (")}]".includes(ch)) d--;
    if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

// Occurrences of `name` as a whole identifier ($ and \w are identifier characters).
const occ = (s: string, name: string, call = false) =>
  (s.match(new RegExp("(?<![\\w$])" + name.replace(/\$/g, "\\$") + (call ? "(?=\\()" : "(?![\\w$])"), "g")) ?? []).length;

const UNWIND = [
  "// bend-emit: fold the pending constructors of a looped def, innermost last.",
  "function $unwind$(s, r) {",
  "  for (let i = s.length; i > 0; i -= 2) {",
  "    const o = s[i - 2];",
  "    o[s[i - 1]] = r;",
  "    r = o;",
  "  }",
  "  return r;",
  "}",
  "",
].join("\n");

// The rewritten body, or the reason it cannot be.
function rewrite(name: string, params: string[], body: string): string | string[] {
  const self = name + "(";
  if (/\bfor\s*\(|\bwhile\s*\(|=>|\bfunction\b|\$JMP/.test(body)) return "body has a loop, closure or $JMP";
  const lines = body.split("\n");
  let sites = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)return ([\s\S]*);\s*$/);
    if (!m) {
      if (occ(line, name)) return "self-call outside a return (scrutinee, binding or argument)";
      if (/^\s*return\b/.test(line)) return "multi-line return";
      out.push(line);
      continue;
    }
    const [, ind, expr] = m;
    if (!occ(line, name)) {
      out.push(`${ind}{ const $v = ${expr}; return $unwind$($stk, $v); }`);
      continue;
    }
    if (occ(line, name) !== occ(line, name, true)) return "own name used as a value";
    const c = expr.match(/^\{(\$: "[^"]*"(?:,[\s\S]*)?)\}$/);
    if (!c || close(expr, 0) !== expr.length - 1) return "self-call in a return that is not a constructor";
    const fields = splitTop(c[1]);
    const last = fields[fields.length - 1];
    const lm = last.match(/^("[^"]+"|[A-Za-z_$][\w$]*): \(([\s\S]*)\)$/);
    if (!lm || !lm[2].startsWith(self) || close(lm[2], self.length - 1) !== lm[2].length - 1) {
      return "self-call is not the last field of the constructor (or is nested in another expression)";
    }
    if (fields.slice(0, -1).some((f) => occ(f, name))) return "self-call in a non-final field";
    const args = splitTop(lm[2].slice(self.length, -1));
    if (occ(lm[2], name) !== 1) return "more than one self-call in the last field";
    if (args.length !== params.length) return "argument count differs from parameters";
    const shell = "{" + [...fields.slice(0, -1), `${lm[1]}: null`].join(", ") + "}";
    const set = args.map((a, i) => (a === params[i] ? "" : `const $a${i} = ${a}; `)).join("");
    const asg = args.map((a, i) => (a === params[i] ? "" : `${params[i]} = $a${i}; `)).join("");
    out.push(`${ind}$stk.push(${shell}, ${lm[1]});`);
    out.push(`${ind}{ ${set}${asg}continue; }`);
    sites++;
  }
  if (sites === 0) return "no constructor-final self-call";
  return [out.join("\n")];
}

export function loopify(js: string): { js: string; stayed: Stayed[] } {
  const stayed: Stayed[] = [];
  let helper = false;
  const out = js.replace(/^function (\$[\w$]*\$)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/gm, (whole, name: string, ps: string, body: string) => {
    if (!occ(body, name)) return whole; // not recursive
    const params = ps.split(",").map((p) => p.trim()).filter(Boolean);
    const r = rewrite(name, params, body);
    if (typeof r === "string") {
      stayed.push({ name, reason: r });
      return whole;
    }
    helper = true;
    return `function ${name}(${ps}) {\n  const $stk = [];\n  for (;;) {\n${r[0]}\n  }\n}`;
  });
  return { js: helper ? out.replace(/^function /m, () => UNWIND + "function ") : out, stayed };
}
