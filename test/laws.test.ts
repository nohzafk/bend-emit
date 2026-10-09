// src/laws.ts: a laws/facts file is built without its laws, lemmas and what
// needs them. test.sh builds nothing for it; the tests build it here.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/emit";

const out = mkdtempSync(join(tmpdir(), "bend-emit-laws-test-"));
const r = await build(join(import.meta.dir, "laws.bend"), out);
const dts = readFileSync(r.dts, "utf8");
const mod = (await import(r.js)).default as Record<string, Function>;

test("plain defs and types are emitted", () => {
  expect(Object.keys(mod).filter((k) => !k.includes(".")).sort()).toEqual(["spec_cmp", "spec_cmp_zero", "spec_double", "spec_heavier"]);
  expect(dts).toContain("export type Duo =");
  expect(mod.spec_double(4n)).toBe(8n);
});

test("laws, lemmas and defs that need them are skipped, silently", () => {
  for (const n of ["double_zero", "double_zero_lemma", "uses_lemma", "spec_checked", "twice_zero", "twice_checked"]) {
    expect(Object.keys(mod)).not.toContain(n);
    expect(dts).not.toContain(n);
  }
  expect(r.stayed.length + r.kept.length + r.skipped.length).toBe(0);
});

test("a def with no TypeScript encoding stays in the module, undeclared", () => {
  expect(r.undeclared).toEqual(["spec_cmp"]);
  expect(dts).not.toContain("spec_cmp(");
  expect(dts).toContain("spec_cmp_zero");
});

test("an ordinary file still refuses a def with no TypeScript encoding", async () => {
  const f = join(out, "plain.bend");
  await Bun.write(f, "import Base\n\ndef c(x: Cmp) -> Nat:\n  0n\n");
  expect(build(f, join(out, "plain"))).rejects.toThrow("no TypeScript encoding");
});
