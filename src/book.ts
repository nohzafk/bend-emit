// bend-emit's front end: the core as bend itself reads it.
//
// The core is loaded and checked with bend's own source (bend2/, the version
// BEND_VERSION names; see tools/bend-src), the way `bend <core> -o <out>.mjs`
// does: book_load, book_valid, no TODO left. What comes back is the checked
// Book, and everything below reads it:
//
//   - the JavaScript is comp's js_lib(book, true), the text that command
//     writes, made in this process;
//   - the defs the module exports are the ones js_lib exports;
//   - each def's type, and each data type's constructors and fields, are the
//     checked terms, normalized, each mapped to the runtime's encoding.
//
// No .bend text is parsed here. The one thing the Book does not keep is the
// alias a file gives an import (`import ./generics.bend as G`), which names an
// imported type in TypeScript (G_Err); those come from the import lines (see
// prefixes).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import type * as BendT from "../bend2/bend.ts";

type HTerm = BendT.HTerm;
type Book = BendT.Book;
type Of<K> = Extract<HTerm, { $: K }>;
type BendMod = typeof import("../bend2/bend.ts");
type CompMod = typeof import("../bend2/comp.ts");

export function fail(msg: string): never {
  throw new Error("bend-emit: " + msg);
}

// The bend this tool is built and tested against (BEND_VERSION, beside this
// file's package). bend2/ must hold exactly that version: the module is bend's
// own output, and this tool rewrites its tags and reads its exports, so a
// compiler it was never checked against could change either without a word.
export const BEND_VERSION = readFileSync(new URL("../BEND_VERSION", import.meta.url), "utf8").trim();

export function checkSource(dir: string, want = BEND_VERSION): void {
  const at = join(dir, "VERSION");
  const have = existsSync(at) ? readFileSync(at, "utf8").trim() : "";
  if (have !== want) {
    fail(`needs bend ${want}; ${dir} holds ${have ? `bend ${have}` : "no bend source"} (in a checkout, run sh tools/bend-src)`);
  }
}

let loaded: { Bend: BendMod; Comp: CompMod } | null = null;

async function bend(): Promise<{ Bend: BendMod; Comp: CompMod }> {
  if (loaded) return loaded;
  checkSource(fileURLToPath(new URL("../bend2", import.meta.url)));
  loaded = { Bend: await import("../bend2/bend.ts"), Comp: await import("../bend2/comp.ts") };
  return loaded;
}

// bend's own words for a failed check, as its CLI prints them.
function why(B: BendMod, e: unknown): string {
  if (e instanceof AggregateError) return e.errors.map((m) => Bun.inspect(m, { colors: false })).join("\n") || String(e);
  if (e instanceof RangeError) return "Error: the machine stack overflowed (a deep recursion, or a literal too large to expand)";
  const err = e as BendT.Err;
  return err?.$ === "Err" ? B.err_show(err) : e instanceof Error ? e.message : String(e);
}

export interface Loaded { B: BendMod; book: Book }

// Load and check the core, and everything it imports, as bend does.
export async function load(core: string): Promise<Loaded> {
  const { Bend: B } = await bend();
  const book = B.book_nil();
  try {
    await B.book_load(book, resolve(core), "", new Map());
    B.book_valid(book, 0);
  } catch (e) {
    fail(`bend could not compile ${core}:\n${why(B, e)}`);
  }
  if (book.hols > 0) fail(`bend could not compile ${core}: ${book.hols} TODO${book.hols === 1 ? "" : "s"} found`);
  return { B, book };
}

// The core's JavaScript: what `bend <core> -o <out>.mjs` writes.
export async function javascript({ B, book }: Loaded, core: string): Promise<string> {
  const { Comp } = await bend();
  try {
    return Comp.js_lib(book, true);
  } catch (e) {
    return fail(`bend could not compile ${core}:\n${why(B, e)}`);
  }
}

// A def whose type is IO(...) after its parameters: bend's io_base, which
// stops IO from unfolding to see it.
function ioOf(B: BendMod, book: Book, t: HTerm): boolean {
  const io = book.tlds.IO;
  if (io?.$ !== "Def" || !io.b) return false;
  const stop = { ...book, tlds: Object.assign(Object.create(book.tlds), { IO: { ...io, v: null } }) };
  const [h] = B.term_unapply(B.term_wnf(stop, t));
  return h.$ === "Ref" && h.k === "IO";
}

// The core's own defs the module exports: js_lib's rule (filled, not Base, no
// template parameter, a type that is not IO), less the defs of imported files,
// whose names carry their file's namespace ("generics:first_big").
export function exported({ B, book }: Loaded): string[] {
  return [...new Set(book.order)].filter((k) => {
    const t = book.tlds[k];
    return !k.includes(":") && t?.$ === "Def" && t.v !== null && !t.b && t.x === 0 && !ioOf(B, book, t.T);
  });
}

// ---------------------------------------------------------------------------
// Types

// Base's generic types, each with its number of type parameters and the
// TypeScript type the preamble declares for it (PREAMBLE, below).
const GENERICS: Record<string, { params: number; ts: string }> = {
  List: { params: 1, ts: "BendList" },
  Map: { params: 1, ts: "BendMap" },
  Maybe: { params: 1, ts: "BendMaybe" },
  Result: { params: 2, ts: "BendResult" },
  Either: { params: 2, ts: "BendEither" },
  Array: { params: 1, ts: "BendArray" },
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
  // An Array is a JS array of its elements, of a power-of-two length (2^d for
  // Array.new's depth d). The runtime changes it in place: a def it is passed
  // to owns it.
  "export type BendArray<T> = T[];",
  // A Word(n) is n bits, low first, each a WCon cell; n is not in the type.
  "export type BendWord = { $: \"WNil\" } | { $: \"WCon\"; head: boolean; tail: BendWord };",
  // A type Bend declares and never defines (Base's File, Socket, Chan, ...;
  // `law Chan:`): a runtime value the host can only pass back. Its name and
  // type arguments brand it.
  "declare const be$handle: unique symbol;",
  "export type BendHandle<K extends string, A extends unknown[] = []> = { readonly [be$handle]: [K, ...A] };",
];
// The names the preamble declares. They are public (a host imports them), so a
// data type of the same name is refused rather than renamed.
const PREAMBLE_TYPES = new Set(PREAMBLE.flatMap((l) => l.match(/^export type (\w+)/)?.[1] ?? []));

// A type with no TypeScript encoding. `dependent` marks one that depends on a
// value (a parameter, or a type a def computes): a def so typed is left out
// of the .d.mts, as is one with an erased parameter. Any other refuses the
// build (or, in a laws file, leaves the def out with a warning).
class NoEncoding extends Error {
  constructor(msg: string, readonly dependent: boolean) {
    super("bend-emit: " + msg);
  }
}

// A variable that stands for a parameter while a telescope is opened. Its
// index is far above any bend gives one, so it is never mistaken for bend's.
let probes = 0;
function probe(B: BendMod, k: string): Of<"Var"> {
  return B.Var(k, (1 << 29) + probes++) as Of<"Var">;
}

interface Ctx {
  B: BendMod;
  book: Book;
  names: Map<string, string>; // a data type's key in the Book -> its TypeScript name
  generics: number; // type parameters of polymorphic functions written so far
}

// The kinds of a type's parameters: an index, a value (a quantity, a Nat, any
// data), which the runtime's values do not carry and TypeScript drops; a type
// (a TypeScript type parameter); or another, such as Type -> Type (no
// encoding).
type Kind = "index" | "type" | string;
function kindsOf(c: Ctx, T: HTerm, n: number): Kind[] {
  return c.B.tele_unbind(c.book, T).doms.slice(0, n).map(([, , A]) => {
    const w = c.B.term_wnf(c.book, A);
    return w.$ === "Qnt" || w.$ === "ADT" ? "index" : w.$ === "Typ" ? "type" : show(c, w);
  });
}
function paramKinds(c: Ctx, k: string): Kind[] {
  const tld = c.book.tlds[k] as BendT.ADT;
  return kindsOf(c, tld.T, tld.n);
}

// A type a law declares and nothing defines (`law Chan:` / `for -A: Type` /
// `Data`): its key and its type arguments, or null.
function handleOf(c: Ctx, w: HTerm): { k: string; args: HTerm[] } | null {
  const [h, xs] = c.B.term_unapply(w);
  if (h.$ !== "Ref") return null;
  const tld = c.book.tlds[h.k];
  if (tld?.$ !== "Def" || tld.v !== null) return null;
  const { doms, ret } = c.B.tele_unbind(c.book, tld.T);
  if (doms.length !== xs.length || c.B.term_wnf(c.book, ret).$ !== "Typ") return null;
  const kinds = kindsOf(c, tld.T, doms.length);
  if (kinds.some((x) => x !== "index" && x !== "type")) return null;
  return { k: h.k, args: xs.filter((_, i) => kinds[i] === "type") };
}

function show(c: Ctx, t: HTerm): string {
  try {
    return c.B.term_show(c.B.term_lower(t)).replace(/\^\d+/g, "");
  } catch {
    return t.$;
  }
}

// A data type's local name ("Err" for "generics:Err") is what its file calls it.
const local = (k: string) => k.slice(k.lastIndexOf(":") + 1);

// A Bend type, as the runtime encodes it. `vars` maps a type parameter in
// scope (a data type's own) to its TypeScript name.
function tsType(c: Ctx, t: HTerm, vars: Map<number, string>, where: string): string {
  const w = c.B.term_wnf(c.book, t);
  switch (w.$) {
    case "Var": {
      const v = vars.get(w.i);
      if (v !== undefined) return v;
      throw new NoEncoding(`${where}: a type that depends on the value ${w.k}`, true);
    }
    case "All": {
      // A function, A -> B. The runtime passes a closure as a plain JS
      // function of one argument.
      const x = probe(c.B, w.k);
      if (w.q.$ === "None") {
        // An erased argument is not passed. One that is a type (@-R: Type ->)
        // makes the function generic in it; any other is dropped, and the
        // rest may not depend on it.
        if (c.B.term_wnf(c.book, w.A).$ !== "Typ") return tsType(c, w.B(x), vars, where);
        // Its name is new in the declaration and in every enclosing scope (a
        // data type's parameter may be written be$<name> too), so it shadows
        // nothing the body refers to.
        const inScope = new Set(vars.values());
        let r: string;
        do r = `be$${w.k.replace(/\W/g, "_")}${c.generics++}`; while (inScope.has(r));
        const f = tsType(c, w.B(x), new Map(vars).set(x.i, r), where);
        // A type argument the rest never names leaves nothing generic: the
        // value is the rest's (@-R: Type -> U32 is a number at run time).
        if (!new RegExp(`(?<![\\w$])${r.replace(/\$/g, "\\$")}(?![\\w$])`).test(f)) return f;
        // ((x: A) => B) becomes (<R>(x: A) => B); (<S>...) becomes (<R, S>...).
        if (f.startsWith("(<")) return `(<${r}, ${f.slice(2)}`;
        if (f.startsWith("((")) return `(<${r}>${f.slice(1)}`;
        throw new NoEncoding(`${where}: a value of every type (${show(c, w)})`, false);
      }
      const a = tsType(c, w.A, vars, where);
      return `((x: ${a}) => ${tsType(c, w.B(x), vars, where)})`;
    }
    case "ADT":
      return adtType(c, w, vars, where);
    case "Eql":
      // A proof, {a == b : T}: the runtime holds no evidence, only null. A
      // host that passes one asserts the equation; nothing checks it.
      return "null";
    case "Ref":
    case "App": {
      // Base's Word(n), whatever n is: the runtime's value is n WCon cells,
      // the type it computes for a known n (Word.Con<p>) is BendWord too.
      const [f] = c.B.term_unapply(w);
      if (f.$ === "Ref" && f.k === "Word" && (c.book.tlds.Word as BendT.Def | undefined)?.b) return "BendWord";
      const h = handleOf(c, w);
      if (h) {
        const as = h.args.map((a) => tsType(c, a, vars, where));
        return `BendHandle<${JSON.stringify(h.k)}${as.length ? `, [${as.join(", ")}]` : ""}>`;
      }
    }
    // falls through
    case "Typ":
      // A type a def computes (Pick(b)), or a type as a value.
      throw new NoEncoding(`${where}: a type computed from a value (${show(c, w)})`, true);
    default:
      throw new NoEncoding(`${where}: no TypeScript encoding for the Bend type ${show(c, w)}`, false);
  }
}

function adtType(c: Ctx, w: Of<"ADT">, vars: Map<number, string>, where: string): string {
  if (w.r.length) throw new NoEncoding(`${where}: no TypeScript encoding for a type with constructors removed (${show(c, w)})`, false);
  const tld = c.book.tlds[w.k] as BendT.ADT;
  const kinds = paramKinds(c, w.k);
  const args = w.x.filter((_, i) => kinds[i] !== "index");
  if (tld.b) {
    switch (w.k) {
      // An F32 is the runtime's JS number, rounded to single precision.
      case "Nat": case "U32": case "F32": return "number";
      case "Bool": return "boolean";
      // A Char is the one-code-point string the runtime makes it (char_new is
      // String.fromCodePoint; Char.to_u32 is codePointAt(0)).
      case "String": case "Char": return "string";
      case "Unit": return "BendUnit";
      case "Cmp": return "BendCmp";
      case "Word.Nil": case "Word.Con": return "BendWord";
      case "Sigma": {
        // A pair, A & B: the runtime's {$: "Tuple", fst, snd}, when the type
        // of snd does not depend on fst.
        const [a, b] = args;
        const snd = c.B.term_wnf(c.book, c.B.App(b, probe(c.B, "fst")));
        return `BendPair<${tsType(c, a, vars, where)}, ${tsType(c, snd, vars, where)}>`;
      }
    }
    const g = GENERICS[w.k];
    if (!g) throw new NoEncoding(`${where}: no TypeScript encoding for the Bend type ${w.k} (in ${show(c, w)})`, false);
    return `${g.ts}<${args.map((a) => tsType(c, a, vars, where)).join(", ")}>`;
  }
  const name = c.names.get(w.k) ?? fail(`${where}: type ${w.k} is reached through no import of the core`);
  return args.length ? `${name}<${args.map((a) => tsType(c, a, vars, where)).join(", ")}>` : name;
}

// ---------------------------------------------------------------------------
// Names

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
export const bindable = (n: string) => IDENT.test(n) && !RESERVED.has(n);
// Names TypeScript keeps for its own types: no type alias or type parameter
// can take one.
const TS_TYPES = new Set(["any", "unknown", "never", "number", "bigint", "boolean", "string", "symbol", "void", "object", "undefined"]);
const typeable = (n: string) => bindable(n) && !TS_TYPES.has(n);

// bend's library of hub packages: BEND_LIB, else ~/.bend/lib, as bend reads it.
const bendLib = () => resolve(process.env.BEND_LIB ?? join(homedir(), ".bend", "lib"));

export interface Import { alias: string; path: string }

// The `import <path> as <Alias>` lines at the head of a .bend file, each
// resolved as bend resolves it: a relative path from the file's directory; a
// "0x<hash>/..." path inside the library; a "<name>@<version>/..." path through
// the hash the library records for that name (bend wrote it when it fetched
// the package, which loading the core did). Imports end at the first line that
// is not an import, a comment or blank, as in bend.
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

// The namespace bend gives a file's names in the Book: its path without
// ".bend", from the library for a hub file, else from the core's directory,
// then ":".
function namespaceOf(file: string, top: string): string {
  const lib = existsSync(bendLib()) ? realpathSync(bendLib()) + "/" : "\0";
  return (file.startsWith(lib) ? file.slice(lib.length) : relative(top, file)).replace(/\.bend$/, "") + ":";
}

// A data type's TypeScript name: a dotted Bend name (Parse.Cur) is written
// with _ (Parse_Cur); two types that come out the same are refused below.
const tsName = (n: string) => n.replace(/\./g, "_");

// Each namespace the core reaches, with the TypeScript prefixes its types are
// written under: "" for the core's own; A_ for `import ... as A`; A_B_ for
// what A imports as B. Breadth first, so a file reached two ways has its
// shortest prefix first. The others become aliases of it.
export function prefixes(core: string): Map<string, string[]> {
  const top = dirname(realpathSync(core));
  const out = new Map<string, string[]>([["", [""]]]);
  const queue: [string, string][] = [[realpathSync(core), ""]];
  const seen = new Set<string>();
  while (queue.length) {
    const [file, prefix] = queue.shift()!;
    if (seen.has(file + "\0" + prefix)) continue;
    seen.add(file + "\0" + prefix);
    for (const { alias, path } of importsOf(file)) {
      const p = `${prefix}${alias}_`;
      const ns = namespaceOf(path, top);
      const list = out.get(ns) ?? [];
      if (!list.includes(p)) list.push(p);
      out.set(ns, list);
      // A cycle of imports is bend's to refuse, before this runs.
      queue.push([path, p]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The declaration

export interface Declared { dts: string; undeclared: string[] }

// The .d.mts for the core: every data type of every file it reaches, and each
// exported def whose type TypeScript can write. With `undeclared` (a laws
// file), a def whose type has no encoding is left out and named there; else
// it refuses the build.
export function declarations(l: Loaded, core: string, defs: string[], arity: Map<string, number>, undeclared?: string[]): string {
  const { B, book } = l;
  const pre = prefixes(core);
  const nsOf = (k: string) => k.slice(0, k.lastIndexOf(":") + 1);
  const adts = [...new Set(book.order)].filter((k) => book.tlds[k]?.$ === "ADT" && !book.tlds[k].b);
  // The core's own first, then by the order its imports are reached.
  const rank = [...pre.keys()];
  adts.sort((a, b) => rank.indexOf(nsOf(a)) - rank.indexOf(nsOf(b)));
  const names = new Map<string, string>();
  for (const k of adts) {
    const p = pre.get(nsOf(k));
    if (!p) fail(`type ${local(k)} of ${nsOf(k).slice(0, -1)} is reached through no import this tool can read`);
    names.set(k, p[0] + tsName(local(k)));
  }
  const c: Ctx = { B, book, names, generics: 0 };
  // Every TypeScript type name the declaration writes, aliases included.
  const taken = new Set<string>([...PREAMBLE_TYPES, ...names.values()]);
  for (const k of adts) for (const p of pre.get(nsOf(k))!) taken.add(p + tsName(local(k)));

  const out: string[] = [...PREAMBLE, ""];
  const written = new Map<string, string>();
  const claim = (name: string, source: string) => {
    if (!typeable(name)) fail(`${source}: ${name} cannot name a TypeScript type; rename it`);
    if (PREAMBLE_TYPES.has(name)) fail(`${source}: the name of a type bend-emit declares for Base (${[...PREAMBLE_TYPES].join(", ")}); rename it`);
    const prior = written.get(name);
    if (prior !== undefined) fail(`two types would both be written ${name}: ${prior} and ${source}; rename one`);
    written.set(name, source);
  };
  for (const k of adts) {
    const name = names.get(k)!;
    const ps = pre.get(nsOf(k))!;
    const source = (p: string) => p === "" ? `type ${local(k)} of the core` : `type ${local(k)} imported as ${p.slice(0, -1)}`;
    claim(name, source(ps[0]));
    const tld = book.tlds[k] as BendT.ADT;
    const kinds = paramKinds(c, k);
    const bad = kinds.find((x) => x !== "index" && x !== "type");
    if (bad) fail(`type ${name}: a type parameter of kind ${bad} (only a type, or a value the type is indexed by)`);
    if (tld.c.length === 0) fail(`type ${name}: no constructors, so no value can cross`);
    // Each constructor's type opens on the data type's parameters, then its
    // fields; the parameters are named as the data type names them.
    // A parameter is private to the declaration: one TypeScript cannot bind,
    // or one spelled like a type it could mean, is written be$<name>.
    const param = (n: string) => typeable(n) && !taken.has(n) ? n : "be$" + n;
    const tparams = B.tele_unbind(book, tld.T).doms.slice(0, tld.n).map(([, n]) => param(n)).filter((_, i) => kinds[i] === "type");
    const shape = (ctr: BendT.Ctr) => {
      const vars = new Map<number, string>();
      let T: HTerm = ctr.T;
      for (let i = 0; i < tld.n; i++) {
        const all = B.tele_open(book, T)!;
        const v = probe(B, all.k);
        if (kinds[i] === "type") vars.set(v.i, param(all.k));
        T = all.B(v);
      }
      // An erased field (-f) is not in the runtime's object; it is opened, as
      // a later field's type may name it, and not written.
      const fields: string[] = [];
      for (let i = 0; i < ctr.n; i++) {
        const all = B.tele_open(book, T)!;
        const v = probe(B, all.k);
        if (all.q.$ !== "None") {
          try {
            fields.push(`; ${JSON.stringify(all.k)}: ${tsType(c, all.A, vars, `type ${name}`)}`);
          } catch (e) {
            if (e instanceof NoEncoding) throw new Error(e.message);
            throw e;
          }
        }
        T = all.B(v);
      }
      return "{ $: " + JSON.stringify(local(ctr.k)) + fields.join("") + " }";
    };
    const params = tparams.length ? `<${tparams.join(", ")}>` : "";
    out.push(`export type ${name}${params} = ${tld.c.map(shape).join(" | ")};`);
    for (const alt of ps.slice(1)) {
      const altName = alt + tsName(local(k));
      claim(altName, source(alt));
      out.push(`export type ${altName}${params} = ${name}${params};`);
    }
  }

  out.push("");
  const members: string[] = [];
  for (const k of defs) {
    const sig = signature(c, k, arity, undeclared);
    if (sig === null) continue;
    if (bindable(k)) out.push(`export declare function ${k}${sig};`);
    members.push(`  ${JSON.stringify(k)}${sig};`);
  }
  // bend-emit's own names start with be$, which no def name can spell here.
  const held = "be$default";
  out.push("", `declare const ${held}: {`, ...members, "};", `export default ${held};`, "");
  return out.join("\n");
}

// The number of arguments each def's entry in bend's module takes before it
// runs: its line of `export default {`, `  "<name>": run_lib((a0,..) => ..., <n>),`.
export function arities(js: string): Map<string, number> {
  const out = new Map<string, number>();
  const block = js.slice(js.lastIndexOf("export default {\n"));
  for (const m of block.matchAll(/^ {2}(\["__proto__"\]|"(?:[^"\\]|\\.)*"): run_lib\(.*, (\d+)\),$/gm)) {
    out.set(m[1] === '["__proto__"]' ? "__proto__" : JSON.parse(m[1]), Number(m[2]));
  }
  return out;
}

// A def's TypeScript signature, or null for one the .d.mts leaves out: one
// that returns IO; one with an erased parameter (-A: no runtime position the
// host fills); one whose type depends on a value. Its parameters are the ones
// it declares; what its type takes after them is the return type, a function.
//
// Such a function is declared only when bend's entry for the def takes all
// of its arguments too (`arity`), and so runs it to the final value: bend
// converts what the entry returns as that final value (a String's text), and
// a closure returned before it would be converted as one.
function signature(c: Ctx, k: string, arity: Map<string, number>, undeclared?: string[]): string | null {
  const { B, book } = c;
  const def = book.tlds[k] as BendT.Def;
  let T: HTerm = def.T;
  const doms: Of<"All">[] = [];
  for (let i = 0; i < def.n; i++) {
    const all = B.tele_open(book, T);
    if (all === null) fail(`def ${k}: its type takes fewer than its ${def.n} parameters`);
    if (all.q.$ === "None") return null;
    doms.push(all);
    T = all.B(probe(B, all.k));
  }
  if (ioOf(B, book, T)) return null;
  const where = `def ${k}`;
  const takes = arity.get(k) ?? fail(`${where}: bend's module has no entry for it`);
  let all = 0;
  // An erased argument is not one the entry takes.
  for (let t = B.tele_open(book, T); t !== null; t = B.tele_open(book, t.B(probe(B, t.k)))) if (t.q.$ !== "None") all++;
  try {
    if (takes < doms.length + all) {
      throw new NoEncoding(`${where}: it returns a function bend's module returns unfinished (it takes ${takes} of ${doms.length + all} arguments)`, false);
    }
    // A parameter name is not part of the type contract; one TypeScript cannot
    // bind is written be$<name>, a prefix no Bend name can spell.
    const ps = doms.map((d) => `${bindable(d.k) ? d.k : "be$" + d.k}: ${tsType(c, d.A, new Map(), where)}`);
    return `(${ps.join(", ")}): ${tsType(c, T, new Map(), where)}`;
  } catch (e) {
    if (!(e instanceof NoEncoding)) throw e;
    if (e.dependent) return null;
    // Asked to (a laws file), leave a def without a TypeScript type out of
    // the declaration; it stays in the module.
    if (!undeclared) throw new Error(e.message);
    undeclared.push(k);
    return null;
  }
}
