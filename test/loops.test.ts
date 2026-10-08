// src/loops.ts: which recursive defs become loops, and which stay recursion.
import { expect, test } from "bun:test";
import { loopify } from "../src/loops";

const fn = (name: string, body: string) => `function ${name}(_s_0) {\n${body}\n}`;
const stays = (name: string, body: string) => {
  const src = fn(name, body);
  const r = loopify(src);
  expect(r.js).toBe(src);
  expect(r.stayed.map((s) => s.name)).toEqual([name]);
};

const head = `  if (_s_0.$ === "Nil") {\n    return {$: "Nil"};\n  } else {\n    const _t_0 = _s_0["tail"];\n`;

test("last-field self-call becomes a loop, and folds in order", () => {
  const r = loopify(fn("$f$", head + `    return {$: "Con", "head": (_s_0["head"] + 1), "tail": ($f$(_t_0))};\n  }`));
  expect(r.stayed).toEqual([]);
  expect(r.js).toContain("for (;;)");
  const mod = new Function(r.js + "; return $f$;")();
  let l: any = { $: "Nil" };
  for (let i = 0; i < 300000; i++) l = { $: "Con", head: i, tail: l };
  let o = mod(l), n = 0;
  for (; o.$ === "Con"; o = o.tail) n++;
  expect(n).toBe(300000);
});
const PRE = `
const $Bool$and$ = (a, b) => a && b;
const nat_chk = (n) => { if (n < 0) throw new Error("neg"); return n; };
const $pick_raw$ = (c, a, b) => (c ? a : b);
const $String$eq$ = (a, b) => a === b;
const $add$ = (a, b) => a + b;
const $not$ = (a) => !a;
`;
const run = (src: string, name: string) => new Function(PRE + src + `; return ${name};`)();
// Convert `src`, require no stay, return [original, converted] callables.
const conv = (src: string, name: string) => {
  const r = loopify(src);
  expect(r.stayed).toEqual([]);
  expect(r.js).not.toBe(src);
  return [run(src, name), run(r.js, name)] as const;
};
const list = (n: number, f: (i: number) => any = (i) => i) => {
  let l: any = { $: "Nil" };
  for (let i = n - 1; i >= 0; i--) l = { $: "Cons", head: f(i), tail: l };
  return l;
};
const BIG = 300000;
const lhead = `  if (_s_0.$ === "Nil") {\n    return {$: "Nil"};\n  } else {\n    const _h_0 = _s_0["head"];\n    const _t_0 = _s_0["tail"];\n`;

test("non-final field now loops: values match the recursion", () => {
  const src = fn("$f$", head + `    return {$: "P", "a": ($f$(_t_0)), "b": 1};\n  }`);
  const [o, c] = conv(src, "$f$");
  expect(JSON.stringify(c(list(5)))).toBe(JSON.stringify(o(list(5))));
  let x = c(list(BIG)), n = 0;
  for (; x.$ === "P"; x = x.a) n++;
  expect(n).toBe(BIG);
});
test("two recursive fields: the last is the hole, the first stays a call", () => {
  const src = fn("$f$", head + `    return {$: "P", "a": ($f$(_t_0)), "b": ($f$(_t_0))};\n  }`);
  const [o, c] = conv(src, "$f$");
  expect(JSON.stringify(c(list(6)))).toBe(JSON.stringify(o(list(6))));
});
test("inside another call: later arguments see the parameters as they were", () => {
  const src = fn("$f$", `  if (_s_0.$ === "Nil") {\n    return 0;\n  } else {\n    return $add$(($f$(_s_0["tail"])), _s_0["head"]);\n  }`);
  const [o, c] = conv(src, "$f$");
  expect(c(list(10))).toBe(o(list(10)));
  expect(c(list(BIG))).toBe((BIG * (BIG - 1)) / 2);
});
test("scrutinee stays: no self-call at the end of a branch", () => stays("$f$", head + `    const _r = $f$(_t_0);\n    if (_r.$ === "Nil") {\n      return {$: "Nil"};\n    } else {\n      return {$: "Con", "head": 1, "tail": _r};\n    }\n  }`));
test("mixed with a tail call", () => {
  const src = fn("$f$", `  for (;;) {\n    if (_s_0.$ === "Nil") {\n      return {$: "Nil"};\n    }\n    return {$: "Con", "head": 1, "tail": ($f$(_s_0["tail"]))};\n  }`);
  const [o, c] = conv(src, "$f$");
  expect(JSON.stringify(c(list(4)))).toBe(JSON.stringify(o(list(4))));
  let n = 0;
  for (let x = c(list(BIG)); x.$ === "Con"; x = x.tail) n++;
  expect(n).toBe(BIG);
});
test("a self-call under || stays", () => stays("$f$", head + `    return (_h_0 || ($f$(_t_0)));\n  }`));

// ---- the shapes of a schema core -------------------------------------------
test("conforms: Bool.and(f(elem, head), f(SList(elem), tail)) inside bend's for(;;)", () => {
  const src = `function $c$($0, $1) {
  for (;;) {
    {
      const _s_0 = $0;
      const _x_0 = $1;
      if (_s_0.$ === "SWrap") {
        $0 = _s_0["s"];
        $1 = _x_0;
        continue;
      } else if (_s_0.$ === "SList") {
        const _e_0 = _s_0["elem"];
        if (_x_0.$ === "Nil") {
          return true;
        } else {
          const _h_0 = _x_0["head"];
          const _t_0 = _x_0["tail"];
          return $Bool$and$(($c$(_e_0, _h_0)), ($c$({$: "SList", "elem": _e_0}, _t_0)));
        }
      } else {
        return _x_0 >= 0;
      }
    }
  }
}`;
  const [o, c] = conv(src, "$c$");
  const sch = { $: "SWrap", s: { $: "SList", elem: { $: "SWrap", s: { $: "SNum" } } } };
  for (const n of [0, 1, 5]) expect(c(sch, list(n))).toBe(o(sch, list(n)));
  expect(c(sch, list(5, (i) => (i === 3 ? -1 : i)))).toBe(false);
  expect(c(sch, list(BIG))).toBe(true);
  expect(c(sch, list(BIG, (i) => (i === BIG - 1 ? -1 : i)))).toBe(false);
});
test("check: first(under(f(elem, head)), later(f(SList(elem), tail))) inside for(;;), with a tail continue", () => {
  const src = `const $first$ = (a, b) => (a === null ? b : a);
const $under$ = (i, r) => (r === null ? null : i + ":" + r);
const $later$ = (r) => r;
function $k$($0, $1) {
  for (;;) {
    {
      const _s_0 = $0;
      const _x_0 = $1;
      if (_s_0.$ === "SRule") {
        $0 = _s_0["s"];
        $1 = _x_0;
        continue;
      } else if (_s_0.$ === "SList") {
        const _e_0 = _s_0["elem"];
        if (_x_0.$ === "Nil") {
          return null;
        } else {
          const _h_0 = _x_0["head"];
          const _t_0 = _x_0["tail"];
          return $first$(($under$(0, ($k$(_e_0, _h_0)))), ($later$(($k$({$: "SList", "elem": _e_0}, _t_0)))));
        }
      } else {
        return _x_0 >= 0 ? null : "neg";
      }
    }
  }
}`;
  const [o, c] = conv(src, "$k$");
  const sch = { $: "SRule", s: { $: "SList", elem: { $: "SNum" } } };
  for (const n of [0, 1, 6]) expect(c(sch, list(n))).toBe(o(sch, list(n)));
  const bad = (n: number, at: number) => list(n, (i) => (i === at ? -1 : i));
  expect(c(sch, bad(6, 4))).toBe(o(sch, bad(6, 4)));
  expect(c(sch, list(BIG))).toBe(null);
  expect(c(sch, bad(BIG, BIG - 2))).toBe("0:neg");
});
test("enc: RCons(enc(e, head), enc(SList(e), tail)) -- the head call stays a call", () => {
  const src = `function $enc$(_e_0, _x_0) {
  if (_x_0.$ === "Nil") {
    return {$: "RNil"};
  } else if (_x_0.$ === "Cons") {
    const _h_0 = _x_0["head"];
    const _t_0 = _x_0["tail"];
    return {$: "RCons", "head": ($enc$(_e_0, _h_0)), "tail": ($enc$({$: "SList", "elem": _e_0}, _t_0))};
  } else {
    return {$: "RNum", "n": _x_0};
  }
}`;
  const [o, c] = conv(src, "$enc$");
  expect(JSON.stringify(c({}, list(4)))).toBe(JSON.stringify(o({}, list(4))));
  let n = 0;
  for (let x = c({}, list(BIG)); x.$ === "RCons"; x = x.tail) n++;
  expect(n).toBe(BIG);
});
test("dec: lcons(dec(e, head), dec(SList(e), tail)) with a user function", () => {
  const src = `const $lcons$ = (h, t) => ({$: "Cons", head: h, tail: t});
function $dec$(_e_0, _r_0) {
  if (_r_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    return $lcons$(($dec$(_e_0, _r_0["head"])), ($dec$({$: "SList", "elem": _e_0}, _r_0["tail"])));
  }
}`;
  const [o, c] = conv(src, "$dec$");
  expect(JSON.stringify(c(0, list(4, (i) => list(0))))).toBe(JSON.stringify(o(0, list(4, (i) => list(0)))));
  let n = 0;
  for (let x = c(0, list(BIG, () => ({ $: "Nil" }))); x.$ === "Cons"; x = x.tail) n++;
  expect(n).toBe(BIG);
});
test("valid_json: nested Bool.and with a not() before the hole", () => {
  const src = `const $key_in$ = (k, l) => l.$ === "Cons" && l.head === k;
function $v$(_v_0) {
  if (_v_0.$ === "JNum") {
    return true;
  } else if (_v_0.$ === "JObject") {
    const _t_1 = _v_0["members"];
    if (_t_1.$ === "Nil") {
      return true;
    } else {
      const _key_0 = _t_1["head"];
      const _tail_1 = _t_1["tail"];
      return $Bool$and$(($v$({$: "JNum"})), ($Bool$and$(($not$(($key_in$(_key_0, _tail_1)))), ($v$({$: "JObject", "members": _tail_1})))));
    }
  } else {
    return false;
  }
}`;
  const [o, c] = conv(src, "$v$");
  const obj = (l: any) => ({ $: "JObject", members: l });
  expect(c(obj(list(5)))).toBe(o(obj(list(5))));
  const dup = obj(list(5, (i) => i >> 1));
  expect(c(dup)).toBe(o(dup));
  expect(c(dup)).toBe(false);
  expect(c(obj(list(BIG)))).toBe(true);
  expect(c(obj(list(BIG, (i) => (i === BIG - 3 ? i + 1 : i))))).toBe(false);
});
test("raw_len: nat_chk(f(tail)) + 1", () => {
  const src = fn("$f$", `  if (_s_0.$ === "Cons") {\n    const _t_0 = _s_0["tail"];\n    return nat_chk(($f$(_t_0)) + 1);\n  } else {\n    return 0;\n  }`);
  const [o, c] = conv(src, "$f$");
  expect(c(list(7))).toBe(o(list(7)));
  expect(c(list(BIG))).toBe(BIG);
});
test("lookup / drop_key / key_once_at: pick_raw(cond, a, rec) eager arguments", () => {
  const lk = fn("$f$", `  if (_s_0.$ === "Cons") {\n    const _k_0 = _s_0["head"];\n    const _rest_0 = _s_0["tail"];\n    return $pick_raw$(($String$eq$(_k_0, "x")), 1, ($f$(_rest_0)));\n  } else {\n    return 0;\n  }`);
  const [lo, lc] = conv(lk, "$f$");
  for (const l of [list(0), list(5), list(5, (i) => (i === 3 ? "x" : "y"))]) expect(lc(l)).toBe(lo(l));
  expect(lc(list(BIG, (i) => (i === BIG - 1 ? "x" : "y")))).toBe(1);
  const dk = fn("$f$", `  if (_s_0.$ === "Cons") {\n    const _j_0 = _s_0["head"];\n    const _o_0 = _s_0["tail"];\n    return $pick_raw$(($String$eq$(_j_0, "x")), _o_0, {$: "Cons", "head": _j_0, "tail": ($f$(_o_0))});\n  } else {\n    return _s_0;\n  }`);
  const [dc0, dc] = conv(dk, "$f$");
  const l = list(6, (i) => (i === 2 ? "x" : "y"));
  expect(JSON.stringify(dc(l))).toBe(JSON.stringify(dc0(l)));
  let n = 0;
  for (let x = dc(list(BIG, () => "y")); x.$ === "Cons"; x = x.tail) n++;
  expect(n).toBe(BIG);
});

test("a self-call bound in a const (key_in, in_names)", () => {
  const src = fn("$f$", `  if (_s_0.$ === "Nil") {
    return false;
  } else {
    const _n_0 = _s_0["head"];
    const _t_0 = _s_0["tail"];
    const _x_1 = ($String$eq$(_n_0, "needle"));
    const _x_2 = ($f$(_t_0));
    return (_x_1 || _x_2);
  }`);
  const [o, c] = conv(src, "$f$");
  for (const l of [list(0), list(6, (i) => (i === 4 ? "needle" : "y")), list(6, () => "y")]) expect(c(l)).toBe(o(l));
  expect(c(list(BIG, (i) => (i === BIG - 1 ? "needle" : "y")))).toBe(true);
  expect(c(list(BIG, () => "y"))).toBe(false);
});
test("a const hole inside bend's for(;;) with tail continues", () => {
  const src = `function $g$($0, $1) {
  for (;;) {
    {
      const _m_0 = $0;
      const _l_0 = $1;
      if (_m_0 === 0) {
        $0 = 1;
        $1 = _l_0;
        continue;
      } else if (_l_0.$ === "Nil") {
        return false;
      } else {
        const _h_0 = _l_0["head"];
        const _x_0 = (_h_0 === 99);
        const _x_1 = ($g$(1, _l_0["tail"]));
        return (_x_0 || _x_1);
      }
    }
  }
}`;
  const [o, c] = conv(src, "$g$");
  for (const l of [list(0), list(5), list(5, (i) => (i === 3 ? 99 : i))]) expect(c(0, l)).toBe(o(0, l));
  expect(c(0, list(BIG, (i) => (i === BIG - 1 ? 99 : i + 100)))).toBe(true);
  expect(c(0, list(BIG, (i) => i + 100))).toBe(false);
});
test("own name as a value", () => stays("$f$", head + `    return {$: "Con", "head": $f$, "tail": ($f$(_t_0))};\n  }`));

test("the frame-folding helper does not collide with a def named unwind", () => {
  const user = `function $unwind$(_s_0) {\n  return 7;\n}`;
  const src = user + "\n" + fn("$f$", head + `    return {$: "P", "a": ($f$(_t_0)), "b": 1};\n  }`);
  const r = loopify(src);
  expect(r.stayed).toEqual([]);
  expect(r.js).toContain(user);
  expect(r.js.match(/^function \$unwind\$\(/gm)?.length).toBe(1);
  expect(r.js.match(/^function be\$unwind\(/gm)?.length).toBe(1);
  const m = new Function(r.js + "; return [$unwind$, $f$];")();
  expect(m[0]()).toBe(7);
  expect(m[1]({ $: "Con", head: 0, tail: { $: "Nil" } })).toEqual({ $: "P", a: { $: "Nil" }, b: 1 });
});
