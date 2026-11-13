#!/usr/bin/env bun
// bend-emit: turn a pure Bend core into an ordinary typed ES module.
//
//   bend-emit <core.bend> <outdir>
//
// writes <outdir>/<name>.mjs and <outdir>/<name>.d.mts, so a host can say
// `import { slots } from "./dist/core.mjs"` and tsc knows every def's type.
// The declaration is .d.mts and not .d.ts because the module is .mjs: a .d.ts
// is the declaration for a .js module, and tsc resolves a .mjs by trying
// core.mts then core.d.mts and stopping -- measured with --traceResolution.
// A .d.ts beside a .mjs is a file no tool ever reads.
//
// The JavaScript is bend's own, from bend's ES-module target:
//
//   bend <core.bend> -o <out>.mjs
//
// `bend --help` calls that "an ES module of its non-IO defs, for JS to import",
// and it is what the build below runs. It writes bend's own loader shape,
// `export default { name: fn, ... }`, and nothing else -- no named exports --
// so the tail (see `exportsOf`) binds that object to a name and re-exports each
// def from it, which is what a host's `import { name }` and the .d.mts need.
//
// The types are derived from the .bend source, never written by hand: the
// `type ... is Data:` blocks and the `def` headers are read, and each Bend type
// maps to the runtime's own encoding (BEND.md 4.0). A Bend type this file does
// not know is refused, naming the def -- a guess would be a hand-written type
// again. The def names read from the source must be exactly the names the
// compiled module exports, or nothing is written.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { intrinsics, type Native, type Skipped } from "./intrinsics";
import { entries, type Entry } from "./entries";
import { loopify, type Stayed } from "./loops";
import { lazySelect } from "./select";
import { classify } from "./classes";
import { runtimeTree } from "./laws";
import { peel, type Kept, type Peeled } from "./strpeel";
import { basename, dirname, join, relative, resolve } from "node:path";

interface Ctor { name: string; fields: [string, string][] }
interface Data { name: string; tparams: string[]; ctors: Ctor[] }
interface Def { name: string; params: [string, string][]; ret: string; erased: boolean }

function fail(msg: string): never {
  throw new Error("bend-emit: " + msg);
}

// Split on commas that are not inside <...> or {...}.
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === "-" || ch === "=") && s[i + 1] === ">") {
      cur += ch + ">"; // the > of an arrow (->, or a lambda's =>) is not a closing bracket
      i++;
      continue;
    }
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    if (ch === ">" || ch === "}" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function nameType(s: string): [string, string] {
  const i = s.indexOf(":");
  if (i < 0) fail(`no type in "${s}"`);
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

// The bracket depth at the end of s: (, < and { open; their closers close; the
// > of an arrow (-> or =>) closes nothing.
function depthOf(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === "-" || ch === "=") && s[i + 1] === ">") { i++; continue; }
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    if (ch === ">" || ch === "}" || ch === ")") depth--;
  }
  return depth;
}

// The index of the bracket that closes the one opening at s[i], or -1.
function closes(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if ((ch === "-" || ch === "=") && s[j + 1] === ">") { j++; continue; }
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    if (ch === ">" || ch === "}" || ch === ")") depth--;
    if (depth === 0) return j;
  }
  return -1;
}

const uncomment = (l: string) => l.replace(/\s*#.*$/, "");

// A def header may run over several lines: up to the line where its brackets
// close and it ends in ":". A constructor may too: up to the line where its
// braces close. Each is joined into one line, with a trailing comment dropped,
// so the readers below see one header or one constructor per line.
// A constructor's fields may also be separated by line breaks alone.
function logicalLines(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  let inType = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!/^\s/.test(line) && line.trim() !== "") inType = line.startsWith("type ");
    const header = line.startsWith("def ");
    const ctor = inType && /^\s+[A-Za-z_][\w.]*\{/.test(line);
    if (header || ctor) {
      line = uncomment(line);
      const done = (l: string) => depthOf(l) <= 0 && (!header || /:$/.test(l.trimEnd()));
      while (!done(line) && i + 1 < lines.length && (depthOf(line) > 0 || /^\s/.test(lines[i + 1]))) {
        const next = uncomment(lines[++i]).trim();
        if (next === "") continue;
        const prev = line.trimEnd();
        const sep = /[(<{,]$/.test(prev) || /^[)>}]/.test(next) ? "" : ctor && depthOf(prev) === 1 ? ", " : " ";
        line = prev + sep + next;
      }
      line = line.replace(/,\s*([)}])/g, "$1");
    }
    out.push(line);
  }
  return out;
}

export function readDecls(src: string): { datas: Data[]; defs: Def[] } {
  const lines = logicalLines(src);
  const datas: Data[] = [];
  const defs: Def[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("type ")) {
      // A type may take type parameters of kind Data: `type Both<A: Data, B: Data> is Data:`.
      // `is Type:` declares constructors the runtime encodes as it does Data's.
      const m = uncomment(line).match(/^type ([A-Za-z_][\w.]*)(?:<(.*)>)? is (?:Data|Type):\s*$/);
      if (!m) fail(`only "type X is Data:" or "type X<A: Data, ...> is Data:" is supported: ${line}`);
      // A parameter's mark (`<-A: Data>`) is not part of its name.
      const tparams = m[2] ? splitTop(m[2]).map(nameType).map(([n, k]) => {
        if (k !== "Data") fail(`type ${m[1]}: a type parameter of kind ${k} (only Data is supported): ${line}`);
        return n.replace(/^[+-]/, "");
      }) : [];
      // The body is every indented line up to the next line that is not
      // indented and not blank. A blank line or a comment inside it is bend's
      // to allow, so it is skipped; stopping at a blank line would drop the
      // constructors after it without a word.
      const ctors: Ctor[] = [];
      const body = (l: string) => /^\s+\S/.test(l) || /^\s*$/.test(l);
      let end = i;
      while (end + 1 < lines.length && body(lines[end + 1])) end++;
      while (end > i && /^\s*$/.test(lines[end])) end--;
      for (; i < end; i++) {
        const text = lines[i + 1].trim();
        if (text === "" || text.startsWith("#")) continue;
        // A constructor's tag is its name as written, dots and all.
        const c = text.match(/^([A-Za-z_][\w.]*)\{(.*)\}$/);
        if (!c) fail(`a constructor of ${m[1]} is not Name{field: Type, ...}: ${lines[i + 1]}`);
        ctors.push({ name: c[1], fields: splitTop(c[2]).map(nameType) });
      }
      datas.push({ name: m[1], tparams, ctors });
    } else if (line.startsWith("def ")) {
      // A def after its law takes bare names and no "->": its type is the law's,
      // and it is a proof, not a def a host calls.
      // `def f?(..)` is an unsafe def; the ? is not part of its name.
      const h = line.match(/^def ([A-Za-z_][\w.]*)\??\(/);
      const close = h ? closes(line, h[0].length - 1) : -1;
      if (h && /^:\s*$/.test(line.slice(close + 1))) continue;
      const r = close < 0 ? null : line.slice(close + 1).match(/^\s*->\s*(.*):\s*$/);
      if (!h || !r) fail(`a def header this tool cannot read: ${line}`);
      const m = [line, h[1], line.slice(h[0].length, close), r[1]];
      // A bare name (`a` in `f(a, -A: Kind(a))`) is a quantity: erased.
      const raw = splitTop(m[2]).map((p): [string, string] => /^[A-Za-z_]\w*$/.test(p) ? ["-" + p, "Quant"] : nameType(p));
      // An erased parameter (-A) has no runtime position this tool can vouch
      // for; such a def is kept out of the module (see `hostable`).
      const erased = raw.some(([n]) => n.startsWith("-"));
      const params = raw.map(([n, t]): [string, string] => [n.replace(/^[+-]/, ""), t]);
      defs.push({ name: m[1], params, ret: m[3].trim(), erased });
    }
  }
  return { datas, defs };
}

// The index of the first "->" outside <...>, {...} and (...), or -1.
function topArrow(t: string): number {
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const ch = t[i];
    if (ch === "=" && t[i + 1] === ">") {
      i++; // a lambda's => is not a closing bracket
      continue;
    }
    if (ch === "-" && t[i + 1] === ">") {
      if (depth === 0) return i;
      i++; // the > of a nested arrow is not a closing bracket
      continue;
    }
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    if (ch === ">" || ch === "}" || ch === ")") depth--;
  }
  return -1;
}

// The index of the first "&" outside <...>, {...} and (...), or -1: the pair
// `A & B`. (A quantity, `&2`, is only ever inside <...>.)
function topAmp(t: string): number {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if ((ch === "-" || ch === "=") && t[i + 1] === ">") { i++; continue; }
    if (ch === "<" || ch === "{" || ch === "(") depth++;
    if (ch === ">" || ch === "}" || ch === ")") depth--;
    if (ch === "&" && depth === 0) return i;
  }
  return -1;
}

// Base's generic types, each with its number of type parameters and the
// TypeScript type the preamble declares for it (PREAMBLE, below). A Bend use
// writes either no quantities or one per type parameter, before the types:
// `List<Nat>`, `List<&2, Nat>`, `Result<&2, &2, Err, Nat>`.
const GENERICS: Record<string, { params: number; ts: string }> = {
  List: { params: 1, ts: "BendList" },
  Map: { params: 1, ts: "BendMap" },
  Maybe: { params: 1, ts: "BendMaybe" },
  Result: { params: 2, ts: "BendResult" },
  Either: { params: 2, ts: "BendEither" },
};

// Base's types as the runtime encodes them: a constructor's name, and its
// fields by the names Base gives them.
const PREAMBLE = [
  "export type BendList<T> = { $: \"Nil\" } | { $: \"Con\"; head: T; tail: BendList<T> };",
  "export type BendMap<T> = { $: \"MTip\" } | { $: \"MLeaf\"; key: string; val: T } | { $: \"MNode\"; pos: number; lo: BendMap<T>; hi: BendMap<T> };",
  "export type BendMaybe<T> = { $: \"None\" } | { $: \"Some\"; value: T };",
  "export type BendResult<E, A> = { $: \"Fail\"; error: E } | { $: \"Done\"; value: A };",
  "export type BendEither<A, B> = { $: \"Inl\"; value: A } | { $: \"Inr\"; value: B };",
  "export type BendUnit = { $: \"Unit\" };",
  "export type BendPair<A, B> = { $: \"Tuple\"; fst: A; snd: B };",
  "export type BendCmp = { $: \"LT\" } | { $: \"EQ\" } | { $: \"GT\" };",
];
// The names the preamble declares. They are public (a host imports them), so a
// data type of the same name is refused rather than renamed.
const PREAMBLE_TYPES = new Set(PREAMBLE.map((l) => l.match(/^export type (\w+)/)![1]));

// A Bend type as the runtime encodes it. `scope` maps a data type's name, as
// the module that uses it writes it, to its TypeScript name.
function tsType(t: string, datas: Map<string, string>, where: string): string {
  // A + before a type (`+List<Json>`) fills its quantities; the value is the same.
  t = t.replace(/^\+/, "");
  // A parenthesized type, (A & B), is the type inside.
  if (t.startsWith("(") && closes(t, 0) === t.length - 1) return tsType(t.slice(1, -1).trim(), datas, where);
  if (t === "Nat") return "number";
  // An F32 is the runtime's JS number, rounded to single precision.
  if (t === "F32") return "number";
  if (t === "Bool") return "boolean";
  if (t === "String") return "string";
  if (t === "U32") return "number";
  // A Char is the one-code-point string the runtime makes it (char_new is
  // String.fromCodePoint; Char.to_u32 is codePointAt(0)).
  if (t === "Char") return "string";
  if (t === "Unit") return "BendUnit";
  if (t === "Cmp") return "BendCmp";
  // A function type, A -> B, split at its first top-level arrow. The runtime
  // passes a closure as a plain JS function of one argument.
  const arrow = topArrow(t);
  if (arrow >= 0) {
    return `((x: ${tsType(t.slice(0, arrow).trim(), datas, where)}) => ${tsType(t.slice(arrow + 2).trim(), datas, where)})`;
  }
  // A pair, A & B, split at its first top-level & (so A & B & C is A & (B & C)):
  // the runtime's {$: "Tuple", fst, snd}.
  const amp = topAmp(t);
  if (amp >= 0) {
    return `BendPair<${tsType(t.slice(0, amp).trim(), datas, where)}, ${tsType(t.slice(amp + 1).trim(), datas, where)}>`;
  }
  const app = t.match(/^([A-Za-z_][\w.]*)<(.*)>$/);
  if (app && !GENERICS[app[1]] && datas.has(app[1])) {
    return `${datas.get(app[1])}<${splitTop(app[2]).map((a) => tsType(a, datas, where)).join(", ")}>`;
  }
  if (app) {
    const g = GENERICS[app[1]];
    if (!g) return fail(`${where}: no TypeScript encoding for the generic Bend type ${app[1]} (in ${t})`);
    const args = splitTop(app[2]);
    const qs = args.filter((a) => a.startsWith("&")).length;
    const types = args.slice(qs);
    if ((qs !== 0 && qs !== g.params) || types.length !== g.params || types.some((a) => a.startsWith("&"))) {
      fail(`${where}: ${app[1]} takes ${g.params} type(s), after no quantities or one per type: ${t}`);
    }
    return `${g.ts}<${types.map((a) => tsType(a, datas, where)).join(", ")}>`;
  }
  if (datas.has("$param:" + t)) return t;
  const known = datas.get(t);
  if (known) return known;
  return fail(`${where}: no TypeScript encoding for the Bend type ${t}`);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
// Words a module cannot bind as a name. A def so named is reached through the
// default export only, as a def whose name is not an identifier is.
const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import",
  "in", "instanceof", "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "arguments", "eval",
]);
const bindable = (n: string) => IDENT.test(n) && !RESERVED.has(n);

// bend's library of hub packages: BEND_LIB, else ~/.bend/lib, as bend reads it.
const bendLib = () => resolve(process.env.BEND_LIB ?? join(homedir(), ".bend", "lib"));

export interface Import { alias: string; path: string }

// The `import <path> as <Alias>` lines at the head of a .bend file, each
// resolved as bend resolves it: a relative path from the file's directory; a
// "0x<hash>/..." path inside the library; a "<name>@<version>/..." path through
// the hash the library records for that name (bend writes it when it fetches
// the package, so the core is compiled before this is read). Imports end at
// the first line that is not an import, a comment or blank, as in bend.
export function importsOf(file: string): Import[] {
  const out: Import[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (!/^import(\s|$)/.test(t)) break;
    const m = t.match(/^import\s+(\S+\.bend)\s+as\s+([A-Za-z_]\w*)\s*(?:#.*)?$/);
    if (!m) continue; // import Base
    let spec = m[1];
    const nv = spec.match(/^([^/]*@[^/]*)\//);
    if (nv) {
      const at = join(bendLib(), "names", nv[1]);
      if (!existsSync(at)) fail(`${file} imports ${spec}, and ${at}, where bend records its hash, is not there`);
      spec = readFileSync(at, "utf8").trim() + spec.slice(nv[1].length);
    }
    const target = /^0x[0-9a-f]+\//.test(spec) ? join(bendLib(), spec) : resolve(dirname(file), spec);
    if (!existsSync(target)) fail(`${file} imports ${m[1]}, and ${target} is not there`);
    out.push({ alias: m[2], path: realpathSync(target) });
  }
  return out;
}

// The name bend gives a file's defs in the module, before the def's own name:
// its path without ".bend", from the library for a hub file, else from the
// core's directory, then ":".
function namespaceOf(file: string, top: string): string {
  const lib = existsSync(bendLib()) ? realpathSync(bendLib()) + "/" : "\0";
  return (file.startsWith(lib) ? file.slice(lib.length) : relative(top, file)).replace(/\.bend$/, "") + ":";
}

// A data type's TypeScript name: a dotted Bend name (Parse.Cur) is written
// with _ (Parse_Cur); two types that come out the same are refused below.
const tsName = (n: string) => n.replace(/\./g, "_");

// A module's data types, with the scope its own fields are read in: its own
// types, and those of the modules it imports, by the alias it gives them.
export interface Module { prefix: string; datas: Data[]; scope: Map<string, string> }

// The core and every .bend file it imports, transitively. An imported type
// A.Name is Name in module A, and A_Name in TypeScript.
export function modules(path: string, prefix = "", seen = new Set<string>()): Module[] {
  const src = readFileSync(path, "utf8");
  const { datas } = readDecls(src);
  const scope = new Map<string, string>();
  for (const d of datas) scope.set(d.name, prefix + tsName(d.name));
  const out: Module[] = [];
  for (const { alias, path: dep } of importsOf(path)) {
    const depPrefix = `${prefix}${alias}_`;
    const sub = modules(dep, depPrefix, seen);
    for (const d of sub[0].datas) scope.set(`${alias}.${d.name}`, depPrefix + tsName(d.name));
    if (!seen.has(dep + depPrefix)) {
      seen.add(dep + depPrefix);
      out.push(...sub);
    }
  }
  return [{ prefix, datas, scope }, ...out];
}

export function declarations(mods: Module[], defs: Def[], undeclared?: string[]): string {
  const out: string[] = [...PREAMBLE, ""];
  const written = new Map<string, string>();
  for (const { prefix, datas, scope } of mods) {
    for (const d of datas) {
      const name = prefix + tsName(d.name);
      if (!IDENT.test(name)) fail(`type ${d.name}: not a TypeScript identifier`);
      if (PREAMBLE_TYPES.has(name)) fail(`type ${d.name}: the name of a type bend-emit declares for Base (${[...PREAMBLE_TYPES].join(", ")}); rename it`);
      // An import is written <alias>_<Type>, which a local type or another
      // import can spell too; two types of one name do not typecheck.
      const source = prefix === "" ? `type ${d.name} of the core` : `type ${d.name} imported as ${prefix.slice(0, -1)}`;
      const prior = written.get(name);
      if (prior !== undefined) fail(`two types would both be written ${name}: ${prior} and ${source}; rename one`);
      written.set(name, source);
      const inner = new Map(scope);
      for (const p of d.tparams) inner.set("$param:" + p, p);
      const shape = (c: Ctor) => "{ $: " + JSON.stringify(c.name)
        + c.fields.map(([f, t]) => `; ${JSON.stringify(f)}: ${tsType(t, inner, `type ${name}`)}`).join("") + " }";
      if (d.ctors.length === 0) fail(`type ${name}: no constructors, so no value can cross`);
      const params = d.tparams.length ? `<${d.tparams.join(", ")}>` : "";
      out.push(`export type ${name}${params} = ${d.ctors.map(shape).join(" | ")};`);
    }
  }
  const main = mods[0].scope;
  out.push("");
  const members: string[] = [];
  for (const f of defs) {
    // A parameter name is not part of the type contract; one TypeScript cannot
    // bind is written be$<name>, a prefix no Bend name can spell.
    let sig: string;
    try {
      sig = "(" + f.params.map(([n, t]) => `${bindable(n) ? n : "be$" + n}: ${tsType(t, main, `def ${f.name}`)}`).join(", ")
        + "): " + tsType(f.ret, main, `def ${f.name}`);
    } catch (e) {
      // Asked to (a laws file), leave a def without a TypeScript type out of
      // the declaration; it stays in the module.
      if (!undeclared) throw e;
      undeclared.push(f.name);
      continue;
    }
    if (bindable(f.name)) out.push(`export declare function ${f.name}${sig};`);
    members.push(`  ${JSON.stringify(f.name)}${sig};`);
  }
  // bend-emit's own names start with be$, which no def name can spell here.
  const held = "be$default";
  out.push("", `declare const ${held}: {`, ...members, "};", `export default ${held};`, "");
  return out.join("\n");
}

// The bend this tool is built and tested against (BEND_VERSION, beside this
// file's package). Another version is refused, not tried: the module is
// bend's own output, and this tool rewrites its tags and reads its exports, so
// a compiler it was never checked against could change either without a word.
const BEND_VERSION = readFileSync(new URL("../BEND_VERSION", import.meta.url), "utf8").trim();

function checkBend(): void {
  const run = Bun.spawnSync(["bend", "version"], { stderr: "pipe", stdout: "pipe" });
  const have = run.exitCode === 0 ? run.stdout.toString().trim() : "";
  if (have !== `bend ${BEND_VERSION}`) {
    fail(`needs bend ${BEND_VERSION}; \`bend version\` on PATH says ${have ? `"${have}"` : "nothing (no bend on PATH)"}`);
  }
}

// Compile the core with bend's ES-module target and return what it wrote.
export function bundle(core: string): string {
  checkBend();
  const tmp = mkdtempSync(join(tmpdir(), "bend-lib-"));
  try {
    const out = join(tmp, "core.mjs");
    const run = Bun.spawnSync(["bend", core, "-o", out], { stderr: "pipe", stdout: "pipe" });
    if (run.exitCode !== 0) fail(`bend could not compile ${core}:\n${run.stdout.toString()}${run.stderr.toString()}`);
    return readFileSync(out, "utf8");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// bend's module is `export default { name: fn, ... }` and nothing else. A host
// says `import { name } from "./dist/core.mjs"`, and the .d.mts declares those
// names, so the object is bound to `be$default` and each def is re-exported from it.
// What the module exports by default stays bend's own object, unchanged.
//
// A def's name is not declared in the module's scope: bend's runtime already
// has top-level functions such as `run_lib` and `nat_host`, and a def of the
// same name would redeclare it. The object is bound to `be$default` and each
// def to `be$<i>`; bend never writes a name starting with `be$`, so they cannot
// collide. Each def is exported under its own name.
//
// bend writes the statement straight after the module's last line of code,
// with no line break: after the closing brace of a lifted closure, as
// `}export default {` (a def that passes a lambda, such as `l => f(t, l)`,
// ends the module so), or after the last `const $$f = ...;` entry that a
// non-tail call goes through. It is put on a line of its own first.
export function exportsOf(raw: string, names: string[]): string {
  const chunk = raw.replace(/^(.*[;}])export default \{$/m, "$1\nexport default {");
  const found = chunk.match(/^export /gm) ?? [];
  if (found.length !== 1) fail(`bend's module has ${found.length} exports, not one: ${found.join(", ")}`);
  if (!/^export default \{$/m.test(chunk)) fail("bend's module has no `export default {` of its own");
  const held = "be$default";
  const pub = names.filter(bindable);
  const local = (i: number) => `be$${i}`;
  const body = chunk.replace(/^export default \{$/m, `const ${held} = {`).trimEnd();
  return [
    body,
    `export default ${held};`,
    ...pub.map((n, i) => `const ${local(i)} = ${held}[${JSON.stringify(n)}];`),
    ...(pub.length ? [`export { ${pub.map((n, i) => `${local(i)} as ${n}`).join(", ")} };`] : []),
    "",
  ].join("\n");
}

// The export-name prefixes of every .bend file a core reaches, transitively
// (see namespaceOf): "../keys/core:" from comp, "generics:" for
// "./generics.bend", "0x<hash>/bytes:" for a hub file. (Through bend 2.0.37
// the separator was ".".)
//
// A constructor's tag needs no such care: since 2.0.38 bend tags it with its
// name in the file that declares it ("TooBig", not "generics.TooBig"), which is
// the name the .d.mts and every host that builds values by hand speak.
export function importPrefixes(path: string, top = dirname(realpathSync(path)), seen = new Set<string>(), out = new Set<string>()): Set<string> {
  if (seen.has(path)) return out;
  seen.add(path);
  for (const { path: dep } of importsOf(path)) {
    out.add(namespaceOf(dep, top));
    importPrefixes(dep, top, seen, out);
  }
  return out;
}

type Built = { js: string; dts: string; stayed: Stayed[]; kept: Kept[]; peeled: Peeled[]; native: Native[]; skipped: Skipped[]; entered: Entry[]; undeclared: string[] };

// A file that holds laws or lemmas is built from a copy without them (see
// laws.ts), and there a def with no TypeScript type is left out of the .d.mts
// with a warning; for any other file it still fails the build.
export async function build(corePath: string, outDir: string): Promise<Built> {
  const tree = runtimeTree(resolve(corePath));
  try {
    return await buildCore(tree.path, outDir, tree.path !== resolve(corePath));
  } finally {
    tree.cleanup();
  }
}

async function buildCore(core: string, outDir: string, lenient: boolean): Promise<Built> {
  // First, so bend has fetched every hub package the core imports.
  const compiled = bundle(core);
  const { defs } = readDecls(readFileSync(core, "utf8"));
  // bend exports every filled def whose whole type is not IO -- so not a
  // def with no parameters that returns IO (main is the usual one), but a
  // def with parameters that returns IO, yes -- except a def with a template
  // parameter (~rule: bend's .mjs target does not export it). Of those, the
  // .d.mts declares the defs whose types it can write: not one returning IO,
  // not one with an erased parameter (-A has no runtime position this tool
  // can vouch for), and not one whose type depends on a value (a type
  // computed by a def, like Meaning(s), is not a TypeScript type). Those stay
  // in the module, undeclared, so the export check below still sees them.
  const lib = defs.filter((d) => !(d.params.length === 0 && d.ret.startsWith("IO(")) && !d.params.some(([n]) => n.startsWith("~")));
  // A def returning Data or Type computes a type; an imported one is written
  // under its alias (S.Meaning).
  const computing = (src: string) => readDecls(src).defs.filter((d) => d.ret === "Data" || d.ret === "Type").map((d) => d.name);
  const computed = new Set(computing(readFileSync(core, "utf8")));
  for (const { alias, path } of importsOf(core)) {
    for (const d of computing(readFileSync(path, "utf8"))) computed.add(`${alias}.${d}`);
  }
  const esc = (x: string) => x.replace(/\./g, "\\.");
  // A use is the name, applied (Meaning(s)) or not (Var, a def of no parameters).
  const dependent = (t: string) => [...computed].some((c) => new RegExp(`(^|[^\\w.])${esc(c)}(?![\\w.])`).test(t));
  const hostable = (d: Def) => !d.ret.startsWith("IO(") && !d.erased && !computed.has(d.name) && !dependent(d.ret) && !d.params.some(([, t]) => dependent(t));
  const undeclared: string[] = [];
  const dts = declarations(modules(core), lib.filter(hostable), lenient ? undeclared : undefined);
  // Shape (B), a constructor whose last field is the self-call, becomes a loop
  // (see loops.ts); what stays a JavaScript recursion is reported by main.
  // Base's String.order.go, which every String comparison goes through, gets a
  // native equivalent (see intrinsics.ts). Before any of them, each call through
  // a `$f` entry is written back as a direct call (see entries.ts).
  const ent = entries(compiled);
  const intr = intrinsics(ent.js);
  const looped = loopify(lazySelect(intr.js).js);
  const peeled = peel(looped.js);
  const chunk = classify(peeled.js);
  const names = lib.map((d) => d.name);
  const js = exportsOf(chunk, names);

  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });
  const stem = basename(core, ".bend");
  const head = `// Generated by bend-emit from ${basename(core)}. Do not edit; rebuild.\n`;
  const jsPath = join(outDir, stem + ".mjs");
  const dtsPath = join(outDir, stem + ".d.mts");
  writeFileSync(jsPath, head + js);

  // The defs read from the source must be the module's exports, exactly.
  const mod = (await import(jsPath + "?t=" + Date.now())).default as Record<string, unknown>;
  // The module also carries the defs of every .bend file the core reaches,
  // directly or through another import; those are theirs. Each is named by
  // its import path as written in the file that imports it
  // ("../schema-lib/core:check", or "generics:first_big" for
  // "./generics.bend"), so the prefixes are collected file by file.
  const imported = [...importPrefixes(core)];
  const have = Object.keys(mod).filter((k) => !imported.some((p) => k.startsWith(p))).sort();
  const want = [...names].sort();
  if (have.join() !== want.join()) {
    rmSync(jsPath);
    fail(`the source's defs and the module's exports differ:\n  source: ${want.join(", ")}\n  module: ${have.join(", ")}`);
  }
  writeFileSync(dtsPath, head + dts);
  return { js: jsPath, dts: dtsPath, stayed: looped.stayed, kept: peeled.kept, peeled: peeled.peeled, native: intr.native, skipped: intr.skipped, entered: ent.kept, undeclared };
}

if (import.meta.main) {
  const [core, out] = process.argv.slice(2);
  if (!core || !out) {
    console.error("usage: bend-emit <core.bend> <outdir>");
    process.exit(2);
  }
  try {
    const r = await build(core, out);
    console.log(`wrote ${r.js} and ${r.dts}`);
    for (const d of r.stayed) console.log(`still recursive: ${d.name.replace(/^\$|\$$/g, "")} (${d.reason})`);
    for (const k of r.kept) console.log(`string still sliced: ${k.name.replace(/^\$|\$$/g, "")} (${k.param}: ${k.reason})`);
    for (const s of r.skipped) console.log(`not made native: ${s.name.replace(/^\$|\$/g, "")} (${s.reason})`);
    for (const e of r.entered) console.log(`call kept through an entry: ${e.name.replace(/^\$+/, "")} (${e.reason})`);
    if (r.undeclared.length) console.log(`no TypeScript encoding, left out of the .d.mts: ${r.undeclared.join(", ")}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
