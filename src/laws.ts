// A file that holds laws and lemmas (a LAWS.bend, a FACTS.bend) is not a core:
// a `law` has no proof there, a lemma is a def whose type states an equation
// {a == b : T}, and both lean on bend-mathlib. bend cannot compile such a
// file to JavaScript, and none of it is runtime. `runtimeTree` writes a copy
// of the file and of every .bend file it imports, transitively, without them:
//
//   skipped: every `law`; every def whose header holds `==` (a lemma); a def
//            named like a law (its proof); every def or type that names a
//            skipped one, directly or through an import alias (`KF.lemma`)
//   dropped: every `import bend-mathlib...` line
//
// Skipping is silent. A file with nothing to skip comes back as it is, so an
// ordinary core is built from its own path, byte for byte as before.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const IMPORT = /^import (\.{1,2}\/\S+\.bend) as ([A-Za-z_]\w*)\s*$/gm;
const nameOf = (b: string) => b.match(/^(?:law|def|type) ([\w.']+)/)?.[1];
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (code: string, n: string) => new RegExp(`(?<![\\w.'])${esc(n)}(?![\\w']|\\.\\w)`).test(code);

// The text of one file without what is not runtime, and the names it skipped.
// `foreign` holds the skipped names of its imports, as this file writes them.
function strip(text: string, foreign: Set<string>): { text: string; skipped: Set<string> } {
  const blocks = text.split(/^(?=law |def |type |import )/m).filter((b) => !/^import bend-mathlib/.test(b));
  const laws = new Set(blocks.filter((b) => b.startsWith("law ")).map((b) => nameOf(b)!));
  const gone = new Set<string>([...laws]);
  const live = blocks.filter((b) => !b.startsWith("law "));
  for (const b of live) {
    const n = nameOf(b);
    if (b.startsWith("def ") && n && (laws.has(n) || b.split("\n")[0].includes("=="))) gone.add(n);
  }
  // A def or type that names a skipped one is skipped, until nothing changes.
  for (let more = true; more; ) {
    more = false;
    for (const b of live) {
      const n = nameOf(b);
      if (!n || gone.has(n) || !/^(def|type) /.test(b)) continue;
      const code = b.replace(/#.*$/gm, "");
      if ([...gone, ...foreign].some((g) => mentions(code, g))) { gone.add(n); more = true; }
    }
  }
  const kept = live.filter((b) => !(/^(def|type) /.test(b) && gone.has(nameOf(b) ?? "\0")));
  return { text: kept.join(""), skipped: gone };
}

// The path to build from, and what to remove afterwards (nothing when the
// file and its imports have nothing to skip).
export function runtimeTree(core: string): { path: string; cleanup: () => void } {
  const done = new Map<string, { text: string; skipped: Set<string> }>();
  const walk = (file: string) => {
    if (done.has(file)) return done.get(file)!;
    done.set(file, { text: "", skipped: new Set() }); // a cycle reads as empty
    const src = readFileSync(file, "utf8");
    const foreign = new Set<string>();
    for (const m of src.matchAll(IMPORT)) {
      for (const s of walk(resolve(dirname(file), m[1])).skipped) foreign.add(`${m[2]}.${s}`);
    }
    const r = strip(src, foreign);
    done.set(file, r);
    return r;
  };
  walk(core);
  const changed = [...done].some(([f, r]) => r.text !== readFileSync(f, "utf8"));
  if (!changed) return { path: core, cleanup: () => {} };
  // Mirror the files under their common ancestor, so every relative import and
  // every path bend-emit derives from one is as it was.
  const files = [...done.keys()];
  let root = dirname(files[0]);
  while (files.some((f) => relative(root, f).startsWith(".."))) root = dirname(root);
  const tmp = mkdtempSync(join(tmpdir(), "bend-emit-laws-"));
  for (const [f, r] of done) {
    const to = join(tmp, relative(root, f));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, r.text);
  }
  return { path: join(tmp, relative(root, core)), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}
