// select.ts: evaluate only the chosen argument of a selector call.
//
// bend evaluates call arguments eagerly, so a core that picks between two
// recursive results with a small def
//
//   def pick(b: Bool, x: T, y: T) -> T:
//     match b: case True{}: x; case False{}: y
//
// computes `pick(c, f(..), g(..))` as BOTH calls and then drops one. This pass
// turns each call to such a def into a conditional, so the unchosen argument
// never runs. Bend is pure and total, so evaluation order and count change no
// value.
//
// Recognition is structural, on the JavaScript bend emits for the def: a body
// that is exactly `if (b) { return p; } else { return q; }`, where b, p, q are
// parameters and b is neither p nor q. In Bend that is a match on one Bool
// parameter whose two arms each return a parameter unchanged (type parameters
// and quantity marks leave no trace in the JavaScript). No name is consulted,
// and a selector from an imported module is recognised the same way, because
// the pass reads the bundled text in which every def sits.
//
// A call is rewritten in two ways:
//   * as the whole of a `return`, into statements
//         if (b) { return X; } else { return Y; }
//     so each self-call stays the last thing its branch returns, where
//     loops.ts turns it into a loop step (a `?:` there would hide it);
//   * anywhere else, into `(b ? X : Y)` -- unless X or Y calls the def being
//     rewritten, since loops.ts leaves a self-call under `?:` as a recursion.
//     Such a call stays as bend wrote it.
// A selector used as a value (not called) is left alone, and the selector def
// itself stays in the module, callable.

import { close, occ, splitTop } from "./loops";

interface Selector { arity: number; b: number; x: number; y: number }

const FN = /^function (\$[\w$]*\$)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/gm;
const RET = /^(\s*)return ([\s\S]*);\s*$/;

// name -> which parameters are the condition and the two results.
function findSelectors(js: string): Map<string, Selector> {
  const out = new Map<string, Selector>();
  for (const m of js.matchAll(FN)) {
    const params = m[2].split(",").map((p) => p.trim()).filter(Boolean);
    const b = m[3].match(/^\s*if \(([\w$]+)\) \{\n\s*return ([\w$]+);\n\s*\} else \{\n\s*return ([\w$]+);\n\s*\}\s*$/);
    if (!b) continue;
    const [i, j, k] = [b[1], b[2], b[3]].map((p) => params.indexOf(p));
    if (i < 0 || j < 0 || k < 0 || i === j || i === k) continue;
    out.set(m[1], { arity: params.length, b: i, x: j, y: k });
  }
  return out;
}

const callRe = (names: string[]) =>
  new RegExp("(?<![\\w$])(" + names.map((n) => n.replace(/\$/g, "\\$")).join("|") + ")\\(", "g");

export function lazySelect(js: string): { js: string; rewritten: number } {
  const sels = findSelectors(js);
  if (sels.size === 0) return { js, rewritten: 0 };
  const re = callRe([...sels.keys()]);
  let rewritten = 0;

  // A selector call at s[at] (name then "(") with its parts, or null.
  const parse = (s: string, at: number, name: string) => {
    const open = at + name.length;
    const end = close(s, open);
    if (end < 0) return null;
    const sel = sels.get(name)!;
    const args = splitTop(s.slice(open + 1, end));
    if (args.length !== sel.arity) return null;
    return { end, c: args[sel.b], x: args[sel.x], y: args[sel.y] };
  };

  // `e` with every selector call a conditional; a call whose arguments hold `self` stays.
  const inline = (e: string, self: string): string => {
    let out = "", last = 0;
    for (const m of e.matchAll(new RegExp(re))) {
      if (m.index! < last) continue;
      const p = parse(e, m.index!, m[1]);
      if (!p || occ(p.x, self) + occ(p.y, self) > 0) continue;
      out += e.slice(last, m.index!) + `(${inline(p.c, self)} ? ${inline(p.x, self)} : ${inline(p.y, self)})`;
      last = p.end + 1;
      rewritten++;
    }
    return out + e.slice(last);
  };

  // `return e;` as statements: a selector call that is all of e becomes an if.
  const lift = (ind: string, e: string, self: string): string[] => {
    const t = e.trim();
    const inner = t[0] === "(" && close(t, 0) === t.length - 1 ? t.slice(1, -1).trim() : t;
    re.lastIndex = 0;
    const m = re.exec(inner);
    if (m && m.index === 0) {
      const p = parse(inner, 0, m[1]);
      if (p && p.end === inner.length - 1) {
        rewritten++;
        return [`${ind}if (${inline(p.c, self)}) {`, ...lift(ind + "  ", p.x, self), `${ind}} else {`, ...lift(ind + "  ", p.y, self), `${ind}}`];
      }
    }
    return [`${ind}return ${inline(e, self)};`];
  };

  const out = js.replace(FN, (whole, name: string, _ps: string, body: string) => {
    if (sels.has(name)) return whole;
    const lines = body.split("\n").flatMap((line) => {
      re.lastIndex = 0;
      if (!re.test(line)) return [line];
      const r = line.match(RET);
      if (r) return lift(r[1], r[2], name);
      return [inline(line, name)];
    });
    return `function ${name}(${_ps}) {\n${lines.join("\n")}\n}`;
  });
  return { js: out, rewritten };
}
