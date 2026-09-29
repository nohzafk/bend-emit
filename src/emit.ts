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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

// The name bend's `export default { ... }` is bound to, so the named exports
// below have something to read. bend writes no such name of its own.
const HELD = "$bend_emit";

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
    if (ch === "-" && s[i + 1] === ">") {
      cur += "->"; // an arrow's > is not a closing bracket
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

export function readDecls(src: string): { datas: Data[]; defs: Def[] } {
  const lines = src.split("\n");
  const datas: Data[] = [];
  const defs: Def[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("type ")) {
      // A type may take type parameters of kind Data: `type Both<A: Data, B: Data> is Data:`.
      const m = line.match(/^type ([A-Za-z_][\w.]*)(?:<(.*)>)? is Data:\s*$/);
      if (!m) fail(`only "type X is Data:" or "type X<A: Data, ...> is Data:" is supported: ${line}`);
      const tparams = m[2] ? splitTop(m[2]).map(nameType).map(([n, k]) => {
        if (k !== "Data") fail(`type ${m[1]}: a type parameter of kind ${k} (only Data is supported): ${line}`);
        return n;
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
        const c = text.match(/^([A-Za-z_]\w*)\{(.*)\}$/);
        if (!c) fail(`a constructor of ${m[1]} is not Name{field: Type, ...}: ${lines[i + 1]}`);
        ctors.push({ name: c[1], fields: splitTop(c[2]).map(nameType) });
      }
      datas.push({ name: m[1], tparams, ctors });
    } else if (line.startsWith("def ")) {
      const m = line.match(/^def ([A-Za-z_][\w.]*)\((.*)\) -> (.*):\s*$/);
      if (!m) fail(`a def header this tool cannot read: ${line}`);
      const raw = splitTop(m[2]).map(nameType);
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

// Base's generic types, each with its number of type parameters and the
// TypeScript type the preamble declares for it (PREAMBLE, below). A Bend use
// writes either no quantities or one per type parameter, before the types:
// `List<Nat>`, `List<&2, Nat>`, `Result<&2, &2, Err, Nat>`.
const GENERICS: Record<string, { params: number; ts: string }> = {
  List: { params: 1, ts: "BendList" },
  Maybe: { params: 1, ts: "BendMaybe" },
  Result: { params: 2, ts: "BendResult" },
  Either: { params: 2, ts: "BendEither" },
};

// Base's types as the runtime encodes them: a constructor's name, and its
// fields by the names Base gives them.
const PREAMBLE = [
  "export type BendList<T> = { $: \"Nil\" } | { $: \"Con\"; head: T; tail: BendList<T> };",
  "export type BendMaybe<T> = { $: \"None\" } | { $: \"Some\"; value: T };",
  "export type BendResult<E, A> = { $: \"Fail\"; error: E } | { $: \"Done\"; value: A };",
  "export type BendEither<A, B> = { $: \"Inl\"; value: A } | { $: \"Inr\"; value: B };",
  "export type BendUnit = { $: \"Unit\" };",
];

// A Bend type as the runtime encodes it. `scope` maps a data type's name, as
// the module that uses it writes it, to its TypeScript name.
function tsType(t: string, datas: Map<string, string>, where: string): string {
  if (t === "Nat") return "bigint";
  if (t === "Bool") return "boolean";
  if (t === "String") return "string";
  if (t === "U32") return "number";
  // A Char is the one-code-point string the runtime makes it (char_new is
  // String.fromCodePoint; Char.to_u32 is codePointAt(0)).
  if (t === "Char") return "string";
  if (t === "Unit") return "BendUnit";
  // A function type, A -> B, split at its first top-level arrow. The runtime
  // passes a closure as a plain JS function of one argument.
  const arrow = topArrow(t);
  if (arrow >= 0) {
    return `((x: ${tsType(t.slice(0, arrow).trim(), datas, where)}) => ${tsType(t.slice(arrow + 2).trim(), datas, where)})`;
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
  if (/^[A-Z]$/.test(t) && datas.has("$param:" + t)) return t;
  const known = datas.get(t);
  if (known) return known;
  return fail(`${where}: no TypeScript encoding for the Bend type ${t}`);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

// A module's data types, with the scope its own fields are read in: its own
// types, and those of the modules it imports, by the alias it gives them.
export interface Module { prefix: string; datas: Data[]; scope: Map<string, string> }

// The core and every .bend file it imports, transitively. An imported type
// A.Name is Name in module A, and A_Name in TypeScript.
export function modules(path: string, prefix = "", seen = new Set<string>()): Module[] {
  const src = readFileSync(path, "utf8");
  const { datas } = readDecls(src);
  const scope = new Map<string, string>();
  for (const d of datas) scope.set(d.name, prefix + d.name);
  const out: Module[] = [];
  for (const m of src.matchAll(/^import (\.{1,2}\/\S+\.bend) as ([A-Za-z_]\w*)\s*$/gm)) {
    const dep = resolve(dirname(path), m[1]);
    const depPrefix = `${prefix}${m[2]}_`;
    const sub = modules(dep, depPrefix, seen);
    for (const d of sub[0].datas) scope.set(`${m[2]}.${d.name}`, depPrefix + d.name);
    if (!seen.has(dep + depPrefix)) {
      seen.add(dep + depPrefix);
      out.push(...sub);
    }
  }
  return [{ prefix, datas, scope }, ...out];
}

export function declarations(mods: Module[], defs: Def[]): string {
  const out: string[] = [...PREAMBLE, ""];
  for (const { prefix, datas, scope } of mods) {
    for (const d of datas) {
      const name = prefix + d.name;
      if (!IDENT.test(name)) fail(`type ${d.name}: not a TypeScript identifier`);
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
    const sig = "(" + f.params.map(([n, t]) => `${n}: ${tsType(t, main, `def ${f.name}`)}`).join(", ")
      + "): " + tsType(f.ret, main, `def ${f.name}`);
    if (IDENT.test(f.name)) out.push(`export declare function ${f.name}${sig};`);
    members.push(`  ${JSON.stringify(f.name)}${sig};`);
  }
  out.push("", "declare const core: {", ...members, "};", "export default core;", "");
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
function bundle(core: string): string {
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

// bend tags a constructor of an imported module with that module's import
// path ("generics.TooBig", "../../bend-schema/core.RCons"). The .d.mts, and
// every host that builds values by hand (bend-schema's codec), speak bare
// names, so the tags are put back to bare names here. Two modules may share a
// constructor name: every match is on a value of a known type, so a tag is
// only ever compared within its own type, as it was before.
export function bareTags(chunk: string, root: string): string {
  const owner = new Map<string, string>();
  const prefixes: [string, Set<string>][] = [];
  const seen = new Set<string>();
  const walk = (file: string, isRoot: boolean) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const ctors = new Set(readDecls(src).datas.flatMap((d) => d.ctors.map((c) => c.name)));
    for (const c of ctors) owner.set(c, file);
    if (!isRoot) prefixes.push([relative(dirname(root), file).replace(/\.bend$/, ""), ctors]);
    for (const m of src.matchAll(/^import (\.{1,2}\/\S+\.bend) as [A-Za-z_]\w*\s*$/gm)) walk(resolve(dirname(file), m[1]), false);
  };
  walk(root, true);
  let out = chunk;
  for (const [prefix, ctors] of prefixes) {
    for (const c of ctors) out = out.split(JSON.stringify(`${prefix}.${c}`)).join(JSON.stringify(c));
  }
  const left = [...out.matchAll(/"([^"\s]*[./][^"\s]*)\.([A-Z]\w*)"/g)].filter((m) => owner.has(m[2]));
  if (left.length) fail(`constructor tags still carry a module path: ${[...new Set(left.map((m) => m[0]))].join(", ")}`);
  return out;
}

// bend's module is `export default { name: fn, ... }` and nothing else. A host
// says `import { name } from "./dist/core.mjs"`, and the .d.mts declares those
// names, so the object is bound to HELD and each def is re-exported from it.
// What the module exports by default stays bend's own object, unchanged.
export function exportsOf(chunk: string, names: string[]): string {
  const found = chunk.match(/^export /gm) ?? [];
  if (found.length !== 1) fail(`bend's module has ${found.length} exports, not one: ${found.join(", ")}`);
  if (!/^export default \{$/m.test(chunk)) fail("bend's module has no `export default {` of its own");
  const body = chunk.replace(/^export default \{$/m, `const ${HELD} = {`).trimEnd();
  return [
    body,
    `export default ${HELD};`,
    ...names.filter((n) => IDENT.test(n)).map((n) => `export const ${n} = ${HELD}[${JSON.stringify(n)}];`),
    "",
  ].join("\n");
}

export async function build(corePath: string, outDir: string): Promise<{ js: string; dts: string }> {
  const core = resolve(corePath);
  const { defs } = readDecls(readFileSync(core, "utf8"));
  // bend exports every filled def that is not IO (main is the usual one),
  // except a def with a template parameter (~rule: bend's .mjs target does not
  // export it). Of those, the .d.mts declares the defs whose types it can write:
  // not one with an erased parameter (-A has no runtime position this tool can
  // vouch for), and not one whose type depends on a value (a type computed by
  // a def, like Meaning(s), is not a TypeScript type). Those stay in the
  // module, undeclared, so the export check below still sees them.
  const lib = defs.filter((d) => !d.ret.startsWith("IO(") && !d.params.some(([n]) => n.startsWith("~")));
  // A def returning Data or Type computes a type; an imported one is written
  // under its alias (S.Meaning).
  const computing = (src: string) => readDecls(src).defs.filter((d) => d.ret === "Data" || d.ret === "Type").map((d) => d.name);
  const computed = new Set(computing(readFileSync(core, "utf8")));
  for (const m of readFileSync(core, "utf8").matchAll(/^import (\.{1,2}\/\S+\.bend) as ([A-Za-z_]\w*)\s*$/gm)) {
    for (const d of computing(readFileSync(resolve(dirname(core), m[1]), "utf8"))) computed.add(`${m[2]}.${d}`);
  }
  const esc = (x: string) => x.replace(/\./g, "\\.");
  const dependent = (t: string) => [...computed].some((c) => new RegExp(`(^|[^\\w.])${esc(c)}\\(`).test(t)) || computed.has(t);
  const hostable = (d: Def) => !d.erased && !computed.has(d.name) && !dependent(d.ret) && !d.params.some(([, t]) => dependent(t));
  const dts = declarations(modules(core), lib.filter(hostable));
  const chunk = bareTags(bundle(core), core);
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
  // The module also carries the defs of the .bend files the core imports,
  // named by their import path ("../schema-lib/core.check", or
  // "generics.first_big" for "./generics.bend"); those are theirs.
  const imported = [...readFileSync(core, "utf8").matchAll(/^import (\.{1,2}\/\S+)\.bend as \w+\s*$/gm)].map((m) => m[1].replace(/^\.\//, "") + ".");
  const have = Object.keys(mod).filter((k) => !imported.some((p) => k.startsWith(p))).sort();
  const want = [...names].sort();
  if (have.join() !== want.join()) {
    rmSync(jsPath);
    fail(`the source's defs and the module's exports differ:\n  source: ${want.join(", ")}\n  module: ${have.join(", ")}`);
  }
  writeFileSync(dtsPath, head + dts);
  return { js: jsPath, dts: dtsPath };
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
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
