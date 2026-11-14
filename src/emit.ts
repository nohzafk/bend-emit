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
// The JavaScript is bend's own: its ES-module target, the text
// `bend <core.bend> -o <out>.mjs` writes, made in this process from bend's own
// source (see book.ts). It is bend's loader shape, `export default { name: fn,
// ... }`, and nothing else -- no named exports -- so the tail (see
// `exportsOf`) binds that object to a name and re-exports each def from it,
// which is what a host's `import { name }` and the .d.mts need.
//
// The types are the checked core's, never written by hand: each def's type and
// each data type's constructors, as bend's checker holds them, map to the
// runtime's own encoding (BEND.md 4.0). A Bend type this tool does not know is
// refused, naming the def -- a guess would be a hand-written type again. The
// defs declared must be exactly the names the compiled module exports, or
// nothing is written.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { intrinsics, type Native, type Skipped } from "./intrinsics";
import { entries, type Entry } from "./entries";
import { loopify, type Stayed } from "./loops";
import { lazySelect } from "./select";
import { lazyArgs, type Reverted } from "./lazy";
import { classify } from "./classes";
import { runtimeTree } from "./laws";
import { peel, type Kept, type Peeled } from "./strpeel";
import { arities, bindable, declarations, exported, fail, javascript, load } from "./book";
import { basename, join, resolve } from "node:path";

export { checkSource, importsOf, prefixes } from "./book";

// Compile the core with bend's ES-module target and return what it wrote.
export async function bundle(core: string): Promise<string> {
  return javascript(await load(core), core);
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

type Built = { js: string; dts: string; eager: Reverted[]; stayed: Stayed[]; kept: Kept[]; peeled: Peeled[]; native: Native[]; skipped: Skipped[]; entered: Entry[]; undeclared: string[] };

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
  const loaded = await load(core);
  // The defs bend's module exports (see book.ts). Of those, the .d.mts
  // declares the defs whose types it can write: not one returning IO, not one
  // with an erased parameter, and not one whose type depends on a value. Those
  // stay in the module, undeclared, so the export check below still sees them.
  const names = exported(loaded);
  const compiled = await javascript(loaded, core);
  const undeclared: string[] = [];
  const dts = declarations(loaded, core, names, arities(compiled), lenient ? undeclared : undefined);
  // Shape (B), a constructor whose last field is the self-call, becomes a loop
  // (see loops.ts); what stays a JavaScript recursion is reported by main.
  // Base's String.order.go, which every String comparison goes through, gets a
  // native equivalent (see intrinsics.ts). Before any of them, each call through
  // a `$f` entry is written back as a direct call (see entries.ts). A call only
  // some paths read is moved to those paths (see select.ts, lazy.ts) before the
  // loops are made, so that a self-call among them becomes a loop step.
  const ent = entries(compiled);
  const intr = intrinsics(ent.js);
  const lazied = lazyArgs(lazySelect(intr.js).js);
  const looped = loopify(lazied.js);
  const peeled = peel(looped.js);
  const chunk = classify(peeled.js);
  const js = exportsOf(chunk, names);

  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });
  const stem = basename(core, ".bend");
  const head = `// Generated by bend-emit from ${basename(core)}. Do not edit; rebuild.\n`;
  const jsPath = join(outDir, stem + ".mjs");
  const dtsPath = join(outDir, stem + ".d.mts");
  writeFileSync(jsPath, head + js);

  // The defs read from the Book must be the module's exports, exactly. The
  // module also carries the defs of every .bend file the core reaches; each
  // is named with its file's namespace, which ends in ":" ("generics:first_big",
  // "0x<hash>/bytes:n"), and a name of the core's own has none.
  const mod = (await import(jsPath + "?t=" + Date.now())).default as Record<string, unknown>;
  const have = Object.keys(mod).filter((k) => !k.includes(":")).sort();
  const want = [...names].sort();
  if (have.join() !== want.join()) {
    rmSync(jsPath);
    fail(`the checked core's defs and the module's exports differ:\n  core: ${want.join(", ")}\n  module: ${have.join(", ")}`);
  }
  writeFileSync(dtsPath, head + dts);
  return { js: jsPath, dts: dtsPath, eager: lazied.reverted, stayed: looped.stayed, kept: peeled.kept, peeled: peeled.peeled, native: intr.native, skipped: intr.skipped, entered: ent.kept, undeclared };
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
    for (const e of r.eager) console.log(`still eager: ${e.name.replace(/^\$|\$$/g, "")} (${e.reason})`);
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
