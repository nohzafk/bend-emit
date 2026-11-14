// lazy.ts: compute a call only on the paths that read its result.
//
// bend evaluates every argument before a call, and a `match` can only test a
// name, so a core that branches on a computed value does it through a helper
// def, and hands that def the result of each branch as an argument:
//
//   def pick.put(ok: Bool, +h: C, t: List<C>, r: Pick) -> Pick:
//     match ok:
//       case True{}:  Got{h, t}
//       case False{}: pick.cons(h, r)
//   ...
//       pick.put(M.ready(h, avail), h, t, pick(t, avail))
//
// `pick(t, avail)` runs even when `ok` is true and the result is dropped: a
// search that should stop at its first hit walks the whole list. Base's
// Bool.and has the same shape, and Bool.or is emitted as
//
//   const _x_0 = <left>;  const _x_1 = <right>;  return (_x_0 || _x_1);
//
// which computes the right side before the `||` looks at the left.
//
// This pass moves such a call to the paths that read it. Four rewrites, applied
// in sweeps over the def until a sweep changes nothing (a def that has not
// settled after a number of sweeps that grows with its size keeps what it has):
//
//   inline  `return $h(args);`, where on some path of $h a parameter is not
//           read and the argument in that position holds a call, becomes the
//           body of $h: each argument that is not a name is bound to a const
//           (be$arg<n>_<i>), in order; the parameters are replaced by those
//           names; the locals of $h are renamed (be$in<n><name>). $h itself
//           stays in the module.
//   lift    `return (A || B);` and `return (A && B);`, where B holds a call
//           or names a const that does, become `if (A) ... else ...`.
//   sink    a const that holds a call, followed by an `if` that reads it in
//           some arms only, moves into those arms.
//   fold    a const this pass wrote, read once by the `return` or the `if`
//           that follows, is written in place; one it moved, when it is all
//           the `return` returns; and any const read once as the right side
//           of a `||` or `&&`.
//
// After them the self-call of such a def is the last thing its branch returns,
// which loops.ts turns into a loop step. For that reason a self-call is never
// folded under `||` or `&&`, where loops.ts would leave the def a recursion;
// and a def loops.ts made a loop before these rewrites and could not after
// them is left as bend wrote it (`reverted`). So is a def whose string
// strpeel.ts carried as an index before them and could not after: a head-only
// reader, placed in the def that walks the string, reads the tail there.
//
// No rewrite adds an evaluation: every path computes a subset of the calls it
// computed before, with the same arguments. Bend is pure, so the values are
// the same. A path that failed (a Nat past the largest immediate, the machine
// stack) in a call it no longer makes now returns.
//
// The pass reads the shape of the text bend emits: a def whose body is
// `const`, `return`, `if` / `else if` / `else`, `for (;;) {`, a bare block,
// `$n = e;` and `continue;`. A def with any other line, or one this file
// would not print back byte for byte, is left as it is and is never inlined.
// A helper is inlined only when it is such a def, does not call itself, holds
// no closure, is at most MAX_HELPER statements, and declares no name twice on
// one path or as one of its parameters (so each of its names can take one new
// name); and only into a def that binds none of the names the helper reads
// from the module.

import { close, loopify, splitTop } from "./loops";
import { peel } from "./strpeel";

// own: a const this pass wrote (an argument, a condition); moved: one it moved.
interface Const { t: "const"; name: string; expr: string; own?: boolean; moved?: boolean }
interface Ret { t: "ret"; expr: string }
interface If { t: "if"; arms: { cond: string; body: Stmt[] }[]; other: Stmt[] | null }
interface Group { t: "group"; head: string; body: Stmt[] }
interface Raw { t: "raw"; text: string }
type Stmt = Const | Ret | If | Group | Raw;

const MAX_HELPER = 24; // statements in a def that may be inlined
const MAX_INLINES = 48; // inlinings into one def

const FN = /^function (\$[\w$]*)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/gm;

// ---------------------------------------------------------------------------
// Text

const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

interface Tok { id: string; at: number }

// The identifiers of an expression, in order: not a property name (after `.`),
// not inside a string, not a number.
const tokCache = new Map<string, Tok[]>();
function toks(e: string): Tok[] {
  let out = tokCache.get(e);
  if (out) return out;
  out = [];
  for (let j = 0; j < e.length; j++) {
    const ch = e[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (j++; j < e.length && e[j] !== ch; j++) if (e[j] === "\\") j++;
      continue;
    }
    const c = e.charCodeAt(j);
    if (!isWord(c)) continue;
    let k = j + 1;
    if (c >= 48 && c <= 57) {
      while (k < e.length && (isWord(e.charCodeAt(k)) || e[k] === ".")) k++;
    } else {
      while (k < e.length && isWord(e.charCodeAt(k))) k++;
      if (j === 0 || e[j - 1] !== ".") out.push({ id: e.slice(j, k), at: j });
    }
    j = k - 1;
  }
  tokCache.set(e, out);
  return out;
}

const idCache = new Map<string, Set<string>>();
function ids(e: string): Set<string> {
  let s = idCache.get(e);
  if (!s) idCache.set(e, (s = new Set(toks(e).map((t) => t.id))));
  return s;
}
const has = (e: string, name: string) => ids(e).has(name);
const count = (e: string, name: string) => toks(e).reduce((n, t) => n + (t.id === name ? 1 : 0), 0);

// `e` with each identifier the map names replaced.
function rename(e: string, map: Map<string, string>): string {
  let out = "", last = 0;
  for (const t of toks(e)) {
    const to = map.get(t.id);
    if (to === undefined) continue;
    out += e.slice(last, t.at) + to;
    last = t.at + t.id.length;
  }
  return last === 0 ? e : out + e.slice(last);
}

// `e` without the parentheses around the whole of it.
function bare(e: string): string {
  e = e.trim();
  while (e[0] === "(" && close(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

const isId = (e: string) => /^[A-Za-z_$][\w$]*$/.test(e);

// `e` as it can stand where a name stood.
function wrap(e: string): string {
  const t = e.trim();
  if (isId(t) || /^\d+$/.test(t)) return t;
  if ("({[".includes(t[0]) && close(t, 0) === t.length - 1) return t;
  const m = t.match(/^[A-Za-z_$][\w$]*(?=\()/);
  if (m && close(t, m[0].length) === t.length - 1) return t;
  return `(${t})`;
}

// `text` with `expr` where the name at `at` stood. A number is not written
// bare before a `.`, which would read as its fraction.
function place(text: string, at: number, name: string, expr: string): string {
  const post = text.slice(at + name.length);
  const w = wrap(expr);
  return text.slice(0, at) + (post[0] === "." && /^\d/.test(w) ? `(${w})` : w) + post;
}

// Is `e` one expression: every bracket closed, and no `;` outside a bracket
// or a string?
function whole(e: string): boolean {
  let d = 0;
  for (let j = 0; j < e.length; j++) {
    const ch = e[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (j++; j < e.length && e[j] !== ch; j++) if (e[j] === "\\") j++;
      continue;
    }
    if ("({[".includes(ch)) d++;
    else if (")}]".includes(ch)) { if (--d < 0) return false; }
    else if (ch === ";" && d === 0) return false;
  }
  return d === 0;
}

// A call to a def of the module that is the whole of `e`.
function callOf(e: string): { name: string; args: string[] } | null {
  const b = bare(e);
  const m = b.match(/^\$[\w$]+(?=\()/);
  if (!m || close(b, m[0].length) !== b.length - 1) return null;
  return { name: m[0], args: splitTop(b.slice(m[0].length + 1, -1)) };
}

// Does `e` hold a call to a def, a closure or a local? Those are what cost;
// an operator, a field read or a constructor is left where bend put it. An
// expression that makes a closure is not moved.
function costly(e: string): boolean {
  if (e.includes("=>")) return false;
  for (const t of toks(e)) {
    if (e[t.at + t.id.length] !== "(") continue;
    if ((t.id[0] === "$" && t.id.length > 1) || t.id[0] === "_" || t.id === "run_clo" || t.id.startsWith("be$arg") || t.id.startsWith("be$in")) return true;
  }
  return false;
}

// `e` split at its one top-level `||` or `&&`; null when it has none, more
// than one, or a `?` or `,` beside it (whose precedence this does not model).
function shortSplit(e: string): { op: "||" | "&&"; a: string; b: string } | null {
  let at = -1, d = 0;
  for (let j = 0; j < e.length; j++) {
    const ch = e[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (j++; j < e.length && e[j] !== ch; j++) if (e[j] === "\\") j++;
      continue;
    }
    if ("({[".includes(ch)) d++;
    else if (")}]".includes(ch)) d--;
    else if (d === 0) {
      if (ch === "?" || ch === ",") return null;
      if ((ch === "|" || ch === "&") && e[j + 1] === ch) {
        if (at >= 0) return null;
        at = j++;
      }
    }
  }
  if (at < 0) return null;
  return { op: e.slice(at, at + 2) as "||" | "&&", a: e.slice(0, at).trim(), b: e.slice(at + 2).trim() };
}

// ---------------------------------------------------------------------------
// Statements

// The statements of a def's body, or null for a body with a line of another shape.
function parse(body: string): Stmt[] | null {
  const lines = body.split("\n").map((l) => l.trim());
  let i = 0, ok = true;
  const block = (): Stmt[] => {
    const out: Stmt[] = [];
    for (; ok && i < lines.length; i++) {
      const t = lines[i];
      if (t.startsWith("}")) return out;
      let m: RegExpMatchArray | null;
      if (t.startsWith("if (") && t.endsWith(") {")) {
        const st: If = { t: "if", arms: [], other: null };
        let cond = t.slice(4, -3);
        for (;;) {
          i++;
          st.arms.push({ cond, body: block() });
          const c = lines[i];
          if (c !== undefined && c.startsWith("} else if (") && c.endsWith(") {")) { cond = c.slice(11, -3); continue; }
          if (c === "} else {") { i++; st.other = block(); }
          if (lines[i] !== "}") ok = false;
          break;
        }
        out.push(st);
      } else if (t === "for (;;) {" || t === "{") {
        i++;
        out.push({ t: "group", head: t, body: block() });
        if (lines[i] !== "}") ok = false;
      } else if ((m = t.match(/^const ([\w$]+) = (.*);$/)) && whole(m[2])) out.push({ t: "const", name: m[1], expr: m[2] });
      else if ((m = t.match(/^return (.*);$/)) && whole(m[1])) out.push({ t: "ret", expr: m[1] });
      else if (t === "continue;" || ((m = t.match(/^[\w$]+ = (.*);$/)) && whole(m[1]))) out.push({ t: "raw", text: t });
      else ok = false;
    }
    return out;
  };
  const top = block();
  return ok && i >= lines.length ? top : null;
}

function print(stmts: Stmt[], ind: string): string[] {
  const out: string[] = [];
  for (const s of stmts) {
    if (s.t === "const") out.push(`${ind}const ${s.name} = ${s.expr};`);
    else if (s.t === "ret") out.push(`${ind}return ${s.expr};`);
    else if (s.t === "raw") out.push(ind + s.text);
    else if (s.t === "group") out.push(ind + s.head, ...print(s.body, ind + "  "), `${ind}}`);
    else {
      s.arms.forEach((a, k) => out.push(`${ind}${k === 0 ? "" : "} else "}if (${a.cond}) {`, ...print(a.body, ind + "  ")));
      if (s.other) out.push(`${ind}} else {`, ...print(s.other, ind + "  "));
      out.push(`${ind}}`);
    }
  }
  return out;
}

// Does the statement read `name` (or declare it)?
function mentions(s: Stmt, name: string): boolean {
  switch (s.t) {
    case "const": return s.name === name || has(s.expr, name);
    case "ret": return has(s.expr, name);
    case "raw": return has(s.text, name);
    case "group": return s.body.some((x) => mentions(x, name));
    case "if": return s.arms.some((a) => has(a.cond, name) || a.body.some((x) => mentions(x, name))) || (s.other?.some((x) => mentions(x, name)) ?? false);
  }
}

function occurrences(s: Stmt, name: string): number {
  const sum = (b: Stmt[]) => b.reduce((n, x) => n + occurrences(x, name), 0);
  switch (s.t) {
    case "const": return (s.name === name ? 1 : 0) + count(s.expr, name);
    case "ret": return count(s.expr, name);
    case "raw": return count(s.text, name);
    case "group": return sum(s.body);
    case "if": return s.arms.reduce((n, a) => n + count(a.cond, name) + sum(a.body), 0) + (s.other ? sum(s.other) : 0);
  }
}

const size = (b: Stmt[]): number =>
  b.reduce((n, s) => n + 1 + (s.t === "group" ? size(s.body) : s.t === "if" ? s.arms.reduce((k, a) => k + size(a.body), 0) + (s.other ? size(s.other) : 0) : 0), 0);

function constNames(b: Stmt[], out: string[] = []): string[] {
  for (const s of b) {
    if (s.t === "const") out.push(s.name);
    else if (s.t === "group") constNames(s.body, out);
    else if (s.t === "if") { for (const a of s.arms) constNames(a.body, out); if (s.other) constNames(s.other, out); }
  }
  return out;
}

function clone(b: Stmt[], map: Map<string, string>): Stmt[] {
  return b.map((s): Stmt => {
    switch (s.t) {
      case "const": return { t: "const", name: map.get(s.name) ?? s.name, expr: rename(s.expr, map), own: s.own, moved: s.moved };
      case "ret": return { t: "ret", expr: rename(s.expr, map) };
      case "raw": return { t: "raw", text: rename(s.text, map) };
      case "group": return { t: "group", head: s.head, body: clone(s.body, map) };
      case "if": return { t: "if", arms: s.arms.map((a) => ({ cond: rename(a.cond, map), body: clone(a.body, map) })), other: s.other && clone(s.other, map) };
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers: the defs a call site may take the body of

// free: the names the helper reads that it does not bind (defs, the runtime).
interface Helper { params: string[]; tree: Stmt[]; lazy: number[]; locals: string[]; free: string[] }

// Every expression of the statements, and the text of each assignment.
function exprs(b: Stmt[], out: string[] = []): string[] {
  for (const s of b) {
    if (s.t === "const" || s.t === "ret") out.push(s.expr);
    else if (s.t === "raw") out.push(s.text);
    else if (s.t === "group") exprs(s.body, out);
    else { for (const a of s.arms) { out.push(a.cond); exprs(a.body, out); } if (s.other) exprs(s.other, out); }
  }
  return out;
}

// The names the statements bind: each const, and each name assigned to.
function binds(b: Stmt[]): string[] {
  const out = constNames(b);
  const raw = (x: Stmt[]) => {
    for (const s of x) {
      if (s.t === "raw") { const m = s.text.match(/^([\w$]+) = /); if (m) out.push(m[1]); }
      else if (s.t === "group") raw(s.body);
      else if (s.t === "if") { for (const a of s.arms) raw(a.body); if (s.other) raw(s.other); }
    }
  };
  raw(b);
  return out;
}

// Can each name the statements declare take one new name everywhere? Yes when
// none is a parameter's, none is declared again inside its own scope, and
// every read of one stands in the scope of a declaration of it: then a name
// means one binding wherever it is spelled.
function scoped(b: Stmt[], params: string[]): boolean {
  const locals = new Set(constNames(b));
  if (params.some((p) => locals.has(p))) return false;
  const block = (x: Stmt[], outer: Set<string>): boolean => {
    const here = new Set(outer);
    const ok = (e: string) => { for (const n of ids(e)) if (locals.has(n) && !here.has(n)) return false; return true; };
    for (const s of x) {
      if (s.t === "const") { if (!ok(s.expr) || here.has(s.name)) return false; here.add(s.name); }
      else if (s.t === "ret") { if (!ok(s.expr)) return false; }
      else if (s.t === "raw") { if (!ok(s.text)) return false; }
      else if (s.t === "group") { if (!block(s.body, here)) return false; }
      else if (!s.arms.every((a) => ok(a.cond) && block(a.body, here)) || (s.other !== null && !block(s.other, here))) return false;
    }
    return true;
  };
  return block(b, new Set());
}

// Only `const`, `return` and `if`, and every path ends in a `return`.
function plain(b: Stmt[]): boolean {
  const each = (x: Stmt[]): boolean => x.every((s) => s.t === "const" || s.t === "ret" || (s.t === "if" && s.arms.every((a) => each(a.body)) && (!s.other || each(s.other))));
  const ends = (x: Stmt[]): boolean => {
    const last = x[x.length - 1];
    return last !== undefined && (last.t === "ret" || (last.t === "if" && last.other !== null && last.arms.every((a) => ends(a.body)) && ends(last.other)));
  };
  return each(b) && ends(b);
}

// The names every path through the statements reads. A `return` that is a
// call to a helper reads only the arguments that helper always reads, and
// `return (A || B);` only A. A path through the arm k of an `if` reads the
// conditions up to k and what the arm always reads.
function always(b: Stmt[], helpers: Map<string, Helper>): Set<string> {
  const out = new Set<string>();
  const add = (e: string) => { for (const x of ids(e)) out.add(x); };
  for (const s of b) {
    if (s.t === "const") add(s.expr);
    else if (s.t === "ret") {
      const c = callOf(s.expr);
      const h = c && helpers.get(c.name);
      const sp = s.expr.includes("=>") ? null : shortSplit(bare(s.expr));
      if (c && h && c.args.length === h.params.length) c.args.forEach((a, i) => { if (!h.lazy.includes(i)) add(a); });
      else if (sp) add(sp.a);
      else add(s.expr);
    } else if (s.t === "if") {
      const conds = new Set<string>();
      const paths: Set<string>[] = [];
      for (const a of s.arms) {
        for (const x of ids(a.cond)) conds.add(x);
        paths.push(new Set([...conds, ...always(a.body, helpers)]));
      }
      paths.push(new Set([...conds, ...(s.other ? always(s.other, helpers) : [])]));
      for (const n of paths[0]) if (paths.every((p) => p.has(n))) out.add(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rewrites

interface Cx {
  self: string;
  helpers: Map<string, Helper>;
  used: Set<string>; // every name the def's text holds
  bound: Set<string>; // the names the def binds: its parameters, its consts, what it assigns to
  n: number;
  inlines: number;
  done: { inlined: number; lifted: number; sunk: number; folded: number };
  changed: boolean;
}

// A const this pass may move: one that holds a call, one it wrote, or one
// that reads such a const (`hot`: their names, in the blocks around it), which
// would otherwise hold that const where it is.
function movable(s: Const, hot: Set<string>): boolean {
  if (s.own) return !isId(s.expr);
  if (s.expr.includes("=>")) return false;
  if (costly(s.expr)) return true;
  for (const x of ids(s.expr)) if (hot.has(x)) return true;
  return false;
}

// inline: the body of the helper a `return` calls, when an argument that holds
// a call sits where the helper does not always read.
function inlineAt(s: Ret, cx: Cx): Stmt[] | null {
  const c = callOf(s.expr);
  if (!c || c.name === cx.self || cx.inlines >= MAX_INLINES) return null;
  const h = cx.helpers.get(c.name);
  if (!h || c.args.length !== h.params.length) return null;
  if (!h.lazy.some((i) => costly(c.args[i]))) return null;
  // A name the helper reads from the module must mean the same here.
  if (h.free.some((f) => cx.bound.has(f))) return null;
  const n = cx.n + 1;
  const map = new Map<string, string>();
  const pre: Stmt[] = [];
  const fresh: string[] = [];
  h.params.forEach((p, i) => {
    const a = c.args[i];
    if (isId(a)) { map.set(p, a); return; }
    const v = `be$arg${n}_${i}`;
    fresh.push(v);
    pre.push({ t: "const", name: v, expr: a, own: true });
    map.set(p, v);
  });
  for (const l of h.locals) { const v = `be$in${n}${l.startsWith("be$") ? l.slice(2) : l}`; fresh.push(v); map.set(l, v); }
  // A name the def already holds would capture, or be captured.
  if (fresh.some((v) => cx.used.has(v))) return null;
  for (const v of fresh) { cx.used.add(v); cx.bound.add(v); }
  cx.n = n;
  cx.inlines++;
  cx.done.inlined++;
  return [...pre, ...clone(h.tree, map)];
}

// lift: `return (A || B);` as statements, when B is what costs.
function liftAt(s: Ret, hot: Set<string>, cx: Cx): Stmt[] | null {
  if (s.expr.includes("=>")) return null;
  const sp = shortSplit(bare(s.expr));
  if (!sp) return null;
  const b = bare(sp.b);
  if (!costly(b) && !hot.has(b)) return null;
  const pre: Stmt[] = [];
  let a = bare(sp.a);
  if (!isId(a)) {
    const v = `be$or${cx.n + 1}`;
    if (cx.used.has(v)) return null;
    cx.used.add(v);
    cx.bound.add(v);
    cx.n++;
    pre.push({ t: "const", name: v, expr: a, own: true });
    a = v;
  }
  cx.done.lifted++;
  const [yes, no] = sp.op === "||" ? [a, sp.b] : [sp.b, a];
  return [...pre, { t: "if", arms: [{ cond: a, body: [{ t: "ret", expr: yes }] }], other: [{ t: "ret", expr: no }] }];
}

// What follows a const, when one statement reads it: where that statement is,
// or -1. Between the two stand only consts that do not rebind a name the
// const's expression reads, and nothing after reads the const.
function soleReader(c: Const, rest: Stmt[]): number {
  const j = rest.findIndex((s) => mentions(s, c.name));
  if (j < 0) return -1;
  const free = ids(c.expr);
  for (let k = 0; k < j; k++) { const s = rest[k]; if (s.t !== "const" || free.has(s.name)) return -1; }
  for (let k = j + 1; k < rest.length; k++) if (mentions(rest[k], c.name)) return -1;
  return j;
}

// sink: `rest` with the const moved into the arms of the `if` that read it;
// null when no path is spared the const. A const this pass wrote moves even
// then: it was an argument of the `return`, and belongs beside the `return`
// of each arm, where fold writes it back.
function sink(c: Const, rest: Stmt[]): Stmt[] | null {
  const j = soleReader(c, rest);
  if (j < 0) return null;
  const s = rest[j];
  if (s.t !== "if" || s.arms.some((a) => has(a.cond, c.name))) return null;
  const free = ids(c.expr);
  let spared = false, blocked = false;
  const into = (body: Stmt[]): Stmt[] => {
    if (!body.some((x) => mentions(x, c.name))) { spared = true; return body; }
    // A const of the arm named like something the expression reads would be read in its place.
    if (body.some((x) => x.t === "const" && (x.name === c.name || free.has(x.name)))) { blocked = true; return body; }
    const deeper = sink(c, body);
    if (deeper) { spared = true; return deeper; }
    return [{ t: "const", name: c.name, expr: c.expr, own: c.own, moved: true }, ...body];
  };
  const arms = s.arms.map((a) => ({ cond: a.cond, body: into(a.body) }));
  const other = s.other ? into(s.other) : null;
  if (!s.other) spared = true;
  if (blocked || !(spared || c.own)) return null;
  return [...rest.slice(0, j), { t: "if", arms, other }, ...rest.slice(j + 1)];
}

// fold: `rest` with the const written into the one statement that reads it.
function fold(c: Const, rest: Stmt[], cx: Cx): Stmt[] | null {
  if (c.own && !rest.some((s) => mentions(s, c.name))) return rest; // read nowhere: an argument the helper drops
  const j = soleReader(c, rest);
  if (j < 0) return null;
  const s = rest[j];
  const put = (x: Stmt) => [...rest.slice(0, j), x, ...rest.slice(j + 1)];
  if (occurrences(s, c.name) !== 1) return null;
  if (s.t === "ret" || s.t === "const") {
    const e = s.expr;
    if (e.includes("=>")) return null;
    if (s.t === "ret" && (c.own || c.moved) && bare(e) === c.name) return put({ t: "ret", expr: c.expr });
    if (s.t === "ret" && c.own) {
      if (!/\|\||&&|\?/.test(e)) {
        const at = toks(e).find((t) => t.id === c.name)!.at;
        return put({ t: "ret", expr: place(e, at, c.name, c.expr) });
      }
    }
    // The right side of a `||` or `&&`: `(A || x)`. Not a self-call, which loops.ts could no longer loop.
    if (costly(c.expr) && !has(c.expr, cx.self)) {
      const at = toks(e).find((t) => t.id === c.name)!.at;
      if (/(\|\||&&) $/.test(e.slice(0, at)) && e[at + c.name.length] === ")") return put({ ...s, expr: place(e, at, c.name, c.expr) });
    }
    return null;
  }
  if (s.t === "if" && c.own) {
    const cond = s.arms[0].cond;
    if (count(cond, c.name) !== 1 || /\|\||&&|\?|=>/.test(cond)) return null;
    const at = toks(cond).find((t) => t.id === c.name)!.at;
    const arms = s.arms.map((a, k) => (k === 0 ? { cond: place(cond, at, c.name, c.expr), body: a.body } : a));
    return put({ t: "if", arms, other: s.other });
  }
  return null;
}

// One sweep over a block and the blocks under it.
function rewrite(block: Stmt[], cx: Cx, around: Set<string>): Stmt[] {
  let out = block;
  const hot = new Set(around);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    let next: Stmt[] | null = null;
    if (s.t === "ret") {
      const r = inlineAt(s, cx) ?? liftAt(s, hot, cx);
      if (r) next = [...out.slice(0, i), ...r, ...out.slice(i + 1)];
    } else if (s.t === "const") {
      if (!movable(s, hot)) continue;
      hot.add(s.name);
      const rest = out.slice(i + 1);
      let r = sink(s, rest);
      if (r) cx.done.sunk++;
      else if ((r = fold(s, rest, cx))) cx.done.folded++;
      if (r) next = [...out.slice(0, i), ...r];
    } else if (s.t === "group") {
      const body = rewrite(s.body, cx, hot);
      if (body !== s.body) { out = [...out.slice(0, i), { t: "group", head: s.head, body }, ...out.slice(i + 1)]; }
      continue;
    } else if (s.t === "if") {
      const arms = s.arms.map((a) => { const body = rewrite(a.body, cx, hot); return body === a.body ? a : { cond: a.cond, body }; });
      const other = s.other && rewrite(s.other, cx, hot);
      if (other !== s.other || arms.some((a, k) => a !== s.arms[k])) out = [...out.slice(0, i), { t: "if", arms, other }, ...out.slice(i + 1)];
      continue;
    }
    if (next) { out = next; cx.changed = true; i--; }
  }
  return out;
}

export interface Reverted { name: string; reason: string }
export interface Lazied { js: string; inlined: number; lifted: number; sunk: number; folded: number; reverted: Reverted[] }

// `guard` off shows what the guards revert (for the tests).
export function lazyArgs(js: string, guard = true): Lazied {
  tokCache.clear();
  idCache.clear();
  interface Def { name: string; ps: string; params: string[]; body: string; tree: Stmt[] | null; out: string | null }
  const defs = new Map<string, Def>();
  const twice = new Set<string>();
  for (const m of js.matchAll(FN)) {
    if (defs.has(m[1])) twice.add(m[1]);
    const tree = parse(m[3]);
    // Only a body this file prints back as it stood is touched.
    const same = tree !== null && print(tree, "  ").join("\n") === m[3];
    defs.set(m[1], { name: m[1], ps: m[2], params: m[2].split(",").map((p) => p.trim()).filter(Boolean), body: m[3], tree: same ? tree : null, out: null });
  }
  for (const n of twice) defs.delete(n);

  // Callees first, so a helper is in its final form, and its lazy positions
  // known, before a def that calls it is read.
  const order: Def[] = [];
  const state = new Map<string, number>();
  const callees = (d: Def) => toks(d.body).filter((t) => d.body[t.at + t.id.length] === "(" && t.id !== d.name && defs.has(t.id)).map((t) => t.id);
  for (const root of defs.values()) {
    if (state.has(root.name)) continue;
    const stack: { d: Def; next: string[] }[] = [{ d: root, next: callees(root) }];
    state.set(root.name, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const c = top.next.pop();
      if (c === undefined) { order.push(top.d); stack.pop(); continue; }
      if (state.has(c)) continue;
      state.set(c, 1);
      const d = defs.get(c)!;
      stack.push({ d, next: callees(d) });
    }
  }

  const helpers = new Map<string, Helper>();
  let done = { inlined: 0, lifted: 0, sunk: 0, folded: 0 };
  const reverted: Reverted[] = [];
  const read = new Set<string>();
  const textOf = (d: Def) => d.out ?? `function ${d.name}(${d.ps}) {\n${d.body}\n}`;
  const loops = (text: string) => loopify(text).stayed.length === 0;
  // The string parameters of a def that strpeel.ts carries as an index, the
  // def standing among the defs it calls, under the head of the runtime's
  // char_len, which strpeel.ts looks for (without it, it carries none).
  const charLen = /^function char_len\(s, at = 0\) \{$/m.exec(js)?.[0];
  const peels = (name: string, text: string, around: string) =>
    charLen === undefined ? [] : peel(loopify(`${charLen}\n}\n\n${around}\n\n${text}`).js).peeled.filter((p) => p.name === name).map((p) => `${p.kind} ${p.param}`);
  for (const d of order) {
    read.add(d.name);
    if (!d.tree) continue;
    const cx: Cx = { self: d.name, helpers, used: new Set([...ids(d.body), ...d.params]), bound: new Set([...d.params, ...binds(d.tree)]), n: 0, inlines: 0, done: { ...done }, changed: false };
    let tree = d.tree;
    // A sweep that changes something moves, removes or places a statement, and
    // a long chain of consts settles one link a sweep.
    for (let left = 1000 + 4 * size(tree); left > 0; left--) {
      cx.changed = false;
      tree = rewrite(tree, cx, new Set());
      if (!cx.changed) break;
    }
    if (tree !== d.tree) {
      const out = `function ${d.name}(${d.ps}) {\n${print(tree, "  ").join("\n")}\n}`;
      // What the passes after this one did for the def, they still do: a def
      // loops.ts made a loop stays one, and a string strpeel.ts carried as an
      // index stays one. Else the def is left as bend wrote it.
      let reason: string | null = null;
      if (guard) {
        const before = textOf(d);
        if (has(d.body, d.name) && !loops(out) && loops(before)) reason = "the rewrite would leave it a recursion";
        else if (d.body.includes("char_len(")) {
          const around = [...new Set(callees(d))].map((c) => textOf(defs.get(c)!)).join("\n\n");
          const after = peels(d.name, out, around);
          if (peels(d.name, before, around).some((p) => !after.includes(p))) reason = "the rewrite would leave its string sliced";
        }
      }
      if (reason !== null) {
        reverted.push({ name: d.name, reason });
        tree = d.tree;
      } else {
        d.tree = tree;
        d.out = out;
        done = cx.done;
      }
    }
    const text = d.out ?? d.body;
    if (!plain(tree) || size(tree) > MAX_HELPER || text.includes("=>") || has(d.body, d.name) || !scoped(tree, d.params)) continue;
    // A def on a cycle of calls is not a helper: inlining it could go round the cycle.
    if (callees(d).some((c) => !read.has(c))) continue;
    const reads = always(tree, helpers);
    const lazy = d.params.map((p, i) => (reads.has(p) ? -1 : i)).filter((i) => i >= 0);
    if (!lazy.length) continue;
    const locals = constNames(tree);
    const mine = new Set([...d.params, ...locals]);
    const free = [...new Set(exprs(tree).flatMap((e) => [...ids(e)]))].filter((n) => !mine.has(n));
    helpers.set(d.name, { params: d.params, tree, lazy, locals, free });
  }

  const out = js.replace(FN, (whole, name: string) => defs.get(name)?.out ?? whole);
  return { js: out, ...done, reverted };
}
