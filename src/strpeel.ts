// strpeel.ts: carry a string that is only ever peeled at its head as (string, index).
//
// bend emits a match on SCon{c, t} over a string as
//
//   if (S === "") {...} else {
//     const C = (S.codePointAt(0) > 0xFFFF ? S.slice(0, 2) : S[0]);   // head
//     const T = (S.codePointAt(0) > 0xFFFF ? S.slice(2) : S.slice(1)); // tail
//
// and the tail is a new string per character: O(n) allocations on an n-char
// input. When a def only ever (1) tests S for "", (2) reads its head, and (3) hands
// the tail to its own next loop step or to a def that itself only tests and reads
// the head, the tail is never needed as a string. It is carried as an index: the
// string parameter stays the same object, and a hidden trailing parameter `be$i<P>`
// (default 0, so every outside caller is unchanged) says where the logical string
// starts. Two shapes are handled:
//
//   reader   function f(.., P, ..)  where every use of P is `P === ""` or the head
//            expression. Gets a trailing `be$iP = 0`.
//   walker   the for(;;) def of loops.ts / bend, whose parameter `$k` is read once
//            per step as `const P = $k;`, and whose tail T is only assigned back
//            to `$k` or passed to a reader.
//
// Anything else is left as bend wrote it (the tail is materialised, as before),
// and reported. The tail is never materialised behind the caller's back: if a
// use is not one of the above, the whole parameter is left alone.

import { close, occ, splitTop } from "./loops";

export interface Peeled { name: string; param: string; kind: "reader" | "walker" }
export interface Kept { name: string; param: string; reason: string }

const esc = (s: string) => s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
const headOf = (p: string) => `(${p}.codePointAt(0) > 0xFFFF ? ${p}.slice(0, 2) : ${p}[0])`;
const tailOf = (p: string) => `(${p}.codePointAt(0) > 0xFFFF ? ${p}.slice(2) : ${p}.slice(1))`;
const idRe = (n: string) => new RegExp("(?<![\\w$])" + esc(n) + "(?![\\w$])", "g");
const ix = (n: string) => "be$i" + n;
const count = (s: string, sub: string) => s.split(sub).length - 1;

// Uses of P left after the given idioms are removed.
function stray(body: string, p: string, idioms: string[]): number {
  let b = body;
  for (const i of idioms) b = b.split(i).join("");
  return occ(b, p);
}

export function peel(js: string): { js: string; peeled: Peeled[]; kept: Kept[] } {
  const peeled: Peeled[] = [];
  const kept: Kept[] = [];
  const fnRe = /^function (\$[\w$]*\$)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/gm;

  // pass 1: readers, and the def -> parameter positions they give
  const readers = new Map<string, number[]>();
  let out = js.replace(fnRe, (whole, name: string, ps: string, body: string) => {
    if (/\bfor\s*\(|\bwhile\s*\(|\$JMP/.test(body)) return whole;
    const params = ps.split(",").map((p) => p.trim()).filter(Boolean);
    const pos: number[] = [];
    let b = body;
    let np = params.slice();
    params.forEach((p, k) => {
      if (!p.startsWith("_")) return;
      const idioms = [`${p} === ""`, headOf(p)];
      if (count(body, headOf(p)) < 1 || stray(body, p, idioms) !== 0) return;
      const q = ix(p);
      b = b.split(`${p} === ""`).join(`${q} >= ${p}.length`)
        .split(headOf(p)).join(`(${p}.codePointAt(${q}) > 0xFFFF ? ${p}.slice(${q}, ${q} + 2) : ${p}[${q}])`);
      np.push(`${q} = 0`);
      pos.push(k);
      peeled.push({ name, param: p, kind: "reader" });
    });
    if (!pos.length) return whole;
    readers.set(name, pos);
    return `function ${name}(${np.join(", ")}) {\n${b}\n}`;
  });

  // pass 2: walkers
  out = out.replace(fnRe, (whole, name: string, ps: string, body: string) => {
    if (!/^\s*for \(;;\) \{/.test(body)) return whole;
    const params = ps.split(",").map((p) => p.trim()).filter(Boolean);
    let b = body;
    const np = params.slice();
    params.forEach((v, k) => {
      const al = b.match(new RegExp("^(\\s*)const (_\\w+) = " + esc(v) + ";$", "m"));
      if (!al) return;
      const P = al[2];
      const vi = ix(v), Pi = ix(P);
      const fail = (reason: string) => { kept.push({ name, param: v, reason }); };
      // the parameter itself: read once, otherwise only assigned
      const assigns = [...b.matchAll(new RegExp("^(\\s*)" + esc(v) + " = ([^\\n]*);$", "gm"))];
      if (occ(b, v) !== 1 + assigns.length) return fail("parameter used other than as its per-step alias and assignments");
      const tm = b.match(new RegExp("^(\\s*)const (_\\w+) = " + esc(tailOf(P)) + ";$", "m"));
      if (!tm) return; // no tail: nothing to save here
      const T = tm[2];
      if (stray(b, P, [`${P} === ""`, headOf(P), tailOf(P)]) !== 1) return fail("string is used other than by test, head and tail");
      // every use of T: `$k = T;` or a reader argument
      let t = b.replace(tm[0], "");
      // rewrite reader calls whose peel position holds T
      let rest = t;
      for (const [f, pos] of readers) {
        const re = new RegExp("(?<![\\w$])" + esc(f) + "\\(", "g");
        let res = "", last = 0;
        for (let m; (m = re.exec(rest)); ) {
          const o = m.index + f.length, e = close(rest, o);
          if (e < 0) continue;
          const args = splitTop(rest.slice(o + 1, e));
          if (!pos.some((p) => args[p] === T)) continue;
          const extra = pos.map((p) => (args[p] === T ? ix(T) : "0"));
          const a2 = args.map((a, i) => (pos.includes(i) && a === T ? P : a));
          res += rest.slice(last, o + 1) + [...a2, ...extra].join(", ") + ")";
          last = e + 1;
          re.lastIndex = e + 1;
        }
        rest = res + rest.slice(last);
      }
      // what is left of T must be `$k = T;`
      const own = new RegExp("^\\s*" + esc(v) + " = " + esc(T) + ";$", "gm");
      const restNoOwn = rest.replace(own, "");
      if (occ(restNoOwn, T) !== 0) return fail("tail is used other than as the next step or a head-only reader's argument");
      // commit
      let r = b;
      r = r.replace(al[0], `${al[1]}const ${P} = ${v};\n${al[1]}const ${Pi} = ${vi};`);
      r = r.replace(tm[0], `${tm[1]}const ${ix(T)} = ${Pi} + (${P}.codePointAt(${Pi}) > 0xFFFF ? 2 : 1);`);
      // reader calls, on r
      for (const [f, pos] of readers) {
        const re = new RegExp("(?<![\\w$])" + esc(f) + "\\(", "g");
        let res = "", last = 0;
        for (let m; (m = re.exec(r)); ) {
          const o = m.index + f.length, e = close(r, o);
          if (e < 0) continue;
          const args = splitTop(r.slice(o + 1, e));
          if (!pos.some((p) => args[p] === T)) continue;
          const extra = pos.map((p) => (args[p] === T ? ix(T) : "0"));
          const a2 = args.map((a, i) => (pos.includes(i) && a === T ? P : a));
          res += r.slice(last, o + 1) + [...a2, ...extra].join(", ") + ")";
          last = e + 1;
          re.lastIndex = e + 1;
        }
        r = res + r.slice(last);
      }
      r = r.replace(new RegExp("^(\\s*)" + esc(v) + " = ([^\\n]*);$", "gm"), (_w, ind: string, x: string) =>
        x === T ? `${ind}${vi} = ${ix(T)};` : `${ind}${v} = ${x}; ${vi} = 0;`);
      r = r.split(`${P} === ""`).join(`${Pi} >= ${P}.length`)
        .split(headOf(P)).join(`(${P}.codePointAt(${Pi}) > 0xFFFF ? ${P}.slice(${Pi}, ${Pi} + 2) : ${P}[${Pi}])`);
      b = r;
      np.push(`${vi} = 0`);
      peeled.push({ name, param: v, kind: "walker" });
    });
    if (np.length === params.length) return whole;
    return `function ${name}(${np.join(", ")}) {\n${b}\n}`;
  });
  return { js: out, peeled, kept };
}
