// entries.ts: read bend's non-tail calls back as direct calls.
//
// Since bend 2.0.40 a call that is not in tail position goes through an entry
// named `$$f`, defined after every function:
//
//   const $$f = $f;                                  // f never jumps
//   const $$f = (a0, a1) => run_loop($f(a0, a1));    // f ends in a tail call
//                                                    // to a closure or a def that does
//
// Bend 2.0.39 wrote the same call in place, as `($f(args))` or
// `run_loop($f(args))`. The passes that follow (loops, strpeel) find a
// def's self-calls by its own name, so they would see none through the entry,
// and a recursion they turned into a loop would stay a recursion. Each call
// `$$f(args)` is written back in the 2.0.39 form, which runs the same function
// with the same arguments, and the entry's definition is removed once nothing
// refers to it. An entry of another shape, or one that is used other than as
// a callee, is left as bend wrote it and reported.

import { close } from "./loops";

export interface Entry { name: string; reason: string }

const PLAIN = /const \$\$([\w$]+) = \$([\w$]+);/g;
const JUMP = /const \$\$([\w$]+) = \(([^)]*)\) => run_loop\(\$([\w$]+)\(([^)]*)\)\);/g;

const esc = (s: string) => s.replace(/\$/g, "\\$");

export function entries(js: string): { js: string; kept: Entry[] } {
  const kept: Entry[] = [];
  const wrap = new Map<string, string>();
  for (const m of js.matchAll(PLAIN)) if (m[1] === m[2]) wrap.set(m[1], "");
  for (const m of js.matchAll(JUMP)) {
    if (m[1] === m[3] && m[2].replace(/\s/g, "") === m[4].replace(/\s/g, "")) wrap.set(m[1], "run_loop");
  }
  for (const m of js.matchAll(/(?<![\w$])\$\$([\w$]+)(?![\w$])/g)) {
    if (!wrap.has(m[1]) && !kept.some((k) => k.name === `$$${m[1]}`)) {
      kept.push({ name: `$$${m[1]}`, reason: "an entry of a shape this bend version does not write" });
    }
  }
  let out = js;
  for (const [name, w] of wrap) {
    // From the last call to the first, so that a call nested in another's
    // arguments (`$$f(x, $$f(y))`) is written before the one around it.
    const callee = `$$${name}(`;
    for (let i = out.lastIndexOf(callee); i !== -1; i = i === 0 ? -1 : out.lastIndexOf(callee, i - 1)) {
      if (i > 0 && /[\w$]/.test(out[i - 1])) continue;
      const open = i + callee.length - 1;
      const end = close(out, open);
      if (end === -1) continue;
      out = out.slice(0, i) + `${w}($${name}${out.slice(open, end + 1)})` + out.slice(end + 1);
    }
    const def = new RegExp(`const ${esc("$$" + name)} = (\\$${esc(name)};|\\([^)]*\\) => run_loop\\(\\$${esc(name)}\\([^)]*\\)\\);)\\n?`);
    const rest = out.replace(def, "");
    if (new RegExp(`(?<![\\w$])${esc("$$" + name)}(?![\\w$])`).test(rest)) {
      kept.push({ name: `$$${name}`, reason: "used other than as the callee of a call" });
    } else {
      out = rest;
    }
  }
  return { js: out, kept };
}
