// loops.ts: turn recursion in bend's emitted JavaScript into a loop.
//
// bend's own backend already turns a tail self-call into `for (;;)` (parameters
// `$0, $1, ...` rebound, `continue`). Any other self-call in a `return` costs
// one JavaScript frame per step. This pass removes that cost for the self-call
// evaluated LAST in the return expression (the "hole"), by heap continuation
// frames:
//
//   return F(A, B(x), $f$(args));        // F, A, B, f are anything
//
// becomes: A and B(x) are evaluated first, in the original order, into consts;
// a closure `r => F(a, b, r)` is pushed on a per-call stack; the parameters
// are rebound to `args`; the loop continues. Every other `return X;` folds the
// stack over X, innermost first. A self-call bound in a `const` that is the
// last one before the branch's `return` is a hole too: the frame holds the rest
// of the branch. The pass knows no names: it reads only the shape of the text.
// Deferring what follows the hole changes no value because the cores are pure
// and total.
//
// Other self-calls (a nested child, `enc(e, head)` in an argument before the
// hole) stay real calls; their depth is bounded elsewhere. A def with no hole,
// a self-call under `||`, `&&` or `?:`, or its own name used as a value is left
// as bend wrote it, and reported.

export interface Stayed { name: string; reason: string }

// Index of the bracket closing the one opened at s[i], skipping JS strings; -1 if none.
export function close(s: string, i: number): number {
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
export function splitTop(s: string): string[] {
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
export const occ = (s: string, name: string, call = false) =>
  (s.match(new RegExp("(?<![\\w$])" + name.replace(/\$/g, "\\$") + (call ? "(?=\\()" : "(?![\\w$])"), "g")) ?? []).length;

// The helper that folds a looped def's pending frames, innermost first.
const UNWIND = "be$unwind";
const unwindHelper = (name: string) => [
  "// bend-emit: fold the pending continuation frames of a looped def, innermost first.",
  `function ${name}(be$s, be$r) {`,
  "  while (be$s.length > 0) be$r = be$s.pop()(be$r);",
  "  return be$r;",
  "}",
  "",
].join("\n");

class Unsupported extends Error {}
const no = (why: string): never => { throw new Unsupported(why); };

const OP = "+-*/%<>=!&|^?:~";
const PREFIX_WORDS = new Set(["new", "typeof", "void"]);

// Skip a JS string literal starting at s[i]; index of its closing quote.
function strEnd(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  for (; j < s.length && s[j] !== q; j++) if (s[j] === "\\") j++;
  return j;
}

// Split a flat expression at its top-level binary operators (precedence is not
// modelled): operands[i] and the operator text seps[i] after it, whitespace kept.
function splitOps(s: string): { operands: string[]; seps: string[] } {
  const operands: string[] = [], seps: string[] = [];
  let start = 0, expect = true, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if ("({[".includes(ch)) {
      const j = close(s, i);
      if (j < 0) no("unbalanced expression");
      i = j + 1; expect = false; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { i = strEnd(s, i) + 1; expect = false; continue; }
    if (OP.includes(ch)) {
      if (expect) { i++; continue; }
      let j = i;
      while (j < s.length && OP.includes(s[j])) j++;
      while (j < s.length && /\s/.test(s[j])) j++;
      operands.push(s.slice(start, i));
      seps.push(s.slice(i, j));
      start = i = j; expect = true; continue;
    }
    if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s[j])) j++;
      if (!(expect && PREFIX_WORDS.has(s.slice(i, j)))) expect = false;
      i = j; continue;
    }
    i++;
  }
  operands.push(s.slice(start));
  return { operands, seps };
}

// prefix operators, then primary and postfix elements ("(..)", "[..]", ".name").
function parseOperand(t: string): { prefix: string; elems: string[] } {
  const prefix = t.match(/^(?:[!~+-]\s*|(?:new|typeof|void)\s+)*/)![0];
  const rest = t.slice(prefix.length);
  const elems: string[] = [];
  let i = 0;
  if (rest === "") no("empty operand");
  if ("({[".includes(rest[0])) {
    const j = close(rest, 0);
    if (j < 0) no("unbalanced operand");
    elems.push(rest.slice(0, j + 1)); i = j + 1;
  } else if (rest[0] === '"' || rest[0] === "'" || rest[0] === "`") {
    i = strEnd(rest, 0) + 1; elems.push(rest.slice(0, i));
  } else {
    const m = rest.match(/^(?:[A-Za-z_$][\w$]*|\d[\w.]*)/);
    if (!m) return no("unrecognised operand");
    elems.push(m[0]); i = m[0].length;
  }
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "(" || ch === "[") {
      const j = close(rest, i);
      if (j < 0) no("unbalanced operand");
      elems.push(rest.slice(i, j + 1)); i = j + 1;
    } else if (ch === ".") {
      const m = rest.slice(i).match(/^\.[\w$]+/);
      if (!m) return no("unrecognised member access");
      elems.push(m[0]); i += m[0].length;
    } else return no("unrecognised operand");
  }
  return { prefix, elems };
}

interface Site { pre: string[]; n: number; hole: string }

// The expression `e` with its LAST-evaluated self-call (the hole) replaced by
// `be$r`. Everything evaluated before the hole is hoisted, in order, into
// `c.pre` as consts; what is evaluated after it stays in the returned text.
function peel(e: string, name: string, c: Site): string {
  const self = name + "(";
  const has = (x: string) => occ(x, name) > 0;
  const lead = (x: string) => x.match(/^\s*/)![0], trail = (x: string) => x.match(/\s*$/)![0];
  const hoist = (raw: string) => {
    const core = raw.trim();
    if (!core.includes("(")) return raw;
    const t = "be$t" + c.n++;
    c.pre.push(`const ${t} = ${core};`);
    return lead(raw) + t + trail(raw);
  };
  const keep = (raw: string, f: (x: string) => string) => lead(raw) + f(raw.trim()) + trail(raw);
  e = e.trim();
  if (e[0] === "(" && close(e, 0) === e.length - 1) return "(" + peel(e.slice(1, -1), name, c) + ")";
  if (e.startsWith(self) && close(e, self.length - 1) === e.length - 1) { c.hole = e; return "be$r"; }

  const { operands, seps } = splitOps(e);
  if (operands.length > 1) {
    let k = -1;
    operands.forEach((x, i) => { if (has(x)) k = i; });
    if (k < 0) return no("no self-call");
    if (/\|\||&&|\?|:/.test(seps.slice(0, k).join(""))) no("self-call after a short-circuit or conditional operator");
    let out = "";
    for (let i = 0; i < k; i++) out += hoist(operands[i]) + seps[i];
    out += keep(operands[k], (x) => peel(x, name, c));
    for (let i = k; i < seps.length; i++) out += seps[i] + operands[i + 1];
    return out;
  }

  const { prefix, elems } = parseOperand(e);
  let j = -1;
  elems.forEach((x, i) => { if (has(x)) j = i; });
  if (j < 0) return no("no self-call");
  if (elems[0] === name && elems.length > 1 && elems[1][0] === "(" && j <= 1) {
    c.hole = name + elems[1];
    return prefix + "be$r" + elems.slice(2).join("");
  }
  const before = prefix + elems.slice(0, j).join("");
  if (has(before) || before.includes("(")) no("a call is evaluated before the self-call");
  const after = elems.slice(j + 1).join("");
  const el = elems[j], inner = el.slice(1, -1);
  if (el[0] === "{" && j === 0) {
    const fs = splitTop(inner);
    let k = -1;
    fs.forEach((x, i) => { if (has(x)) k = i; });
    const re = /^("(?:[^"\\]|\\.)*"|[\w$]+)\s*:\s*([\s\S]*)$/;
    const out = fs.map((f, i) => {
      if (i > k) return f;
      const m = f.match(re);
      if (!m) return no("unrecognised object field");
      return `${m[1]}: ${i < k ? hoist(m[2]) : peel(m[2], name, c)}`;
    });
    return before + "{" + out.join(", ") + "}" + after;
  }
  if (el[0] === "(" || (el[0] === "[" && j === 0)) {
    if (el[0] === "(" && j === 0) return before + "(" + peel(inner, name, c) + ")" + after;
    const xs = splitTop(inner);
    let k = -1;
    xs.forEach((x, i) => { if (has(x)) k = i; });
    const out = xs.map((x, i) => (i < k ? hoist(x) : i === k ? peel(x, name, c) : x));
    return before + el[0] + out.join(", ") + (el[0] === "(" ? ")" : "]") + after;
  }
  if (el[0] === "[") return before + "[" + peel(inner, name, c) + "]" + after;
  return no("self-call in an unrecognised position");
}

// The rewritten body, or the reason it cannot be.
function rewrite(name: string, params: string[], body: string, unwind: string): string | string[] {
  const self = name + "(";
  let inner = body;
  const t = body.trim();
  if (t.startsWith("for (;;) {") && close(t, t.indexOf("{")) === t.length - 1) inner = t.slice(t.indexOf("{") + 1, -1);
  if (/\bfor\s*\(|\bwhile\s*\(|=>|\bfunction\b|\$JMP/.test(inner)) return "body has a nested loop, closure or $JMP";
  const lines = inner.replace(/^\s*\n|\n\s*$/g, "").split("\n");
  const out: string[] = [];
  let sites = 0;
  const retRe = /^(\s*)return ([\s\S]*);\s*$/;
  const constRe = /^(\s*)const ([\w$]+) = ([\s\S]*);\s*$/;
  const shadow = (text: string, fn: string) => {
    const used = params.filter((p) => occ(text, p) > 0);
    return used.length ? `((${used.join(", ")}) => ${fn})(${used.join(", ")})` : fn;
  };
  // pre consts, argument temps, frame push, rebinding, continue.
  const site = (ind: string, c: Site, frame: string | null) => {
    const args = splitTop(c.hole.slice(self.length, -1));
    if (args.length !== params.length) return no("argument count differs from parameters");
    const set = args.map((a, i) => (a === params[i] ? "" : `const be$a${i} = ${a}; `)).join("");
    const asg = args.map((a, i) => (a === params[i] ? "" : `${params[i]} = be$a${i}; `)).join("");
    out.push(`${ind}{`);
    for (const p of c.pre) out.push(`${ind}  ${p}`);
    if (frame !== null) out.push(`${ind}  be$stk.push(${shadow(frame, frame)});`);
    out.push(`${ind}  ${set}${asg}continue;`);
    out.push(`${ind}}`);
    sites++;
  };
  try {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const r = line.match(retRe);
      if (!occ(line, name)) {
        if (r) out.push(`${r[1]}return ${unwind}(be$stk, ${r[2]});`);
        else if (/^\s*return\b/.test(line)) return "multi-line return";
        else out.push(line);
        continue;
      }
      if (occ(line, name) !== occ(line, name, true)) return "own name used as a value";
      if (r) {
        const c: Site = { pre: [], n: 0, hole: "" };
        const f = peel(r[2], name, c);
        if (f.replace(/[()\s]/g, "") === "be$r") site(r[1], c, null);
        else site(r[1], c, `(be$r) => (${f})`);
        continue;
      }
      const cm = line.match(constRe);
      if (cm) {
        const rest: string[] = [];
        let k = i + 1;
        const same = (l: string) => l.startsWith(cm[1]) && !/^\s/.test(l.slice(cm[1].length));
        while (k < lines.length && same(lines[k]) && constRe.test(lines[k]) && !occ(lines[k], name)) rest.push(lines[k++]);
        if (k < lines.length && same(lines[k]) && retRe.test(lines[k]) && !occ(lines[k], name)) {
          rest.push(lines[k]);
          const c: Site = { pre: [], n: 0, hole: "" };
          const f = peel(cm[3], name, c);
          const frame = `(be$r) => { const ${cm[2]} = ${f}; ${rest.map((l) => l.trim()).join(" ")} }`;
          site(cm[1], c, frame);
          i = k;
          continue;
        }
      }
      out.push(line); // a self-call that is not at the end of its branch stays a real call
    }
  } catch (e) {
    if (e instanceof Unsupported) return e.message;
    throw e;
  }
  if (sites === 0) return "no self-call at the end of a branch";
  return [out.join("\n")];
}

export function loopify(js: string): { js: string; stayed: Stayed[] } {
  const stayed: Stayed[] = [];
  let helper = false;
  const unwind = UNWIND;
  const out = js.replace(/^function (\$[\w$]*\$)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/gm, (whole, name: string, ps: string, body: string) => {
    if (!occ(body, name)) return whole; // not recursive
    const params = ps.split(",").map((p) => p.trim()).filter(Boolean);
    const r = rewrite(name, params, body, unwind);
    if (typeof r === "string") {
      stayed.push({ name, reason: r });
      return whole;
    }
    helper = true;
    return `function ${name}(${ps}) {\n  const be$stk = [];\n  for (;;) {\n${r[0]}\n  }\n}`;
  });
  return { js: helper ? out.replace(/^function /m, () => unwindHelper(unwind) + "function ") : out, stayed };
}
