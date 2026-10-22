// intrinsics.ts: replace a Base def whose emitted JavaScript is correct but
// slow at scale with a native equivalent.
//
// Every String.eq, String.order and String.is_* in Base goes through
// String.order.go. Since bend 2.0.38 bend emits it as a loop, so it no longer
// recurses, but each step slices the head and the tail off both strings and
// allocates the Cmp of the two heads: a comparison allocates four strings and
// one object per equal leading character. A core that compares many keys (an
// object checked field by field) spends most of its time there; bend-schema's
// wide-object check ran 9x slower than with the native comparison bend-emit
// carried through 2.0.37.
//
// The native String.order.go returns the same Cmp. Base defines it as: c, if c
// is not EQ; else the order of the first differing Char, by its U32 code (the
// one the runtime's char_code reads); else the shorter string is less. A Char
// is one UTF-16 unit when that unit is not a surrogate, and the runtime's
// char_len and char_code read anything else: an astral pair, a lone surrogate,
// or a packed non-scalar (U+DC00 and three units). The common case, two
// non-surrogate units, is compared without a call.
//
// The replacement happens only when the def is exactly the text this bend
// version emits, and the runtime helpers it calls are present; any other text
// is left alone and reported.

export interface Native { name: string }
export interface Skipped { name: string; reason: string }

// The body bend 2.0.38 emits for Base's String.order.go, compared line by line
// with blanks trimmed.
const ORDER_GO_EXPECTED = [
  "for (;;) {",
  "{",
  "const _a_0 = $0;",
  "const _b_0 = $1;",
  "const _c_0 = $2;",
  'if (_a_0 === "") {',
  'if (_b_0 !== "") {',
  'if (_c_0.$ === "EQ") {',
  'return {$: "LT"};',
  "} else {",
  "return _c_0;",
  "}",
  "} else {",
  "return _c_0;",
  "}",
  "} else {",
  "const _t_1 = _a_0.slice(0, char_len(_a_0));",
  "const _t_2 = _a_0.slice(char_len(_a_0));",
  'if (_b_0 === "") {',
  'if (_c_0.$ === "EQ") {',
  'return {$: "GT"};',
  "} else {",
  "return _c_0;",
  "}",
  "} else {",
  "const _t_3 = _b_0.slice(0, char_len(_b_0));",
  "const _t2_0 = _b_0.slice(char_len(_b_0));",
  'if (_c_0.$ === "EQ") {',
  "const _x_0 = char_code(_t_1);",
  "const _x_1 = char_code(_t_3);",
  "$0 = _t_2;",
  "$1 = _t2_0;",
  "$2 = cmp_new(_x_0, _x_1);",
  "continue;",
  "} else {",
  "return _c_0;",
  "}",
  "}",
  "}",
  "}",
  "}",
].join("\n");

// Self-contained but for the runtime's char_len and char_code: no helper is
// added at the top level, where it could collide with the emitted name of a
// def in the core. The literals are bend's own; classify.ts shares them.
const ORDER_GO_NATIVE = [
  "function $String_order_go(_a_0, _b_0, _c_0) {",
  "  // bend-emit: Base's String.order.go, natively: by Char code, then length.",
  '  if (_c_0.$ !== "EQ" || _a_0 === _b_0) return _c_0;',
  "  for (let be$i = 0, be$j = 0;;) {",
  '    if (be$i >= _a_0.length) return be$j >= _b_0.length ? {$: "EQ"} : {$: "LT"};',
  '    if (be$j >= _b_0.length) return {$: "GT"};',
  "    let be$x = _a_0.charCodeAt(be$i), be$y = _b_0.charCodeAt(be$j), be$m = 1, be$n = 1;",
  "    if (be$x >= 0xD800 && be$x < 0xE000) { be$m = char_len(_a_0, be$i); be$x = char_code(_a_0.slice(be$i, be$i + be$m)); }",
  "    if (be$y >= 0xD800 && be$y < 0xE000) { be$n = char_len(_b_0, be$j); be$y = char_code(_b_0.slice(be$j, be$j + be$n)); }",
  '    if (be$x !== be$y) return be$x < be$y ? {$: "LT"} : {$: "GT"};',
  "    be$i += be$m;",
  "    be$j += be$n;",
  "  }",
  "}",
].join("\n");

const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

export function intrinsics(js: string): { js: string; native: Native[]; skipped: Skipped[] } {
  const native: Native[] = [], skipped: Skipped[] = [];
  const re = /^function (\$String_order_go)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/m;
  const helpers = /^function char_len\(s, at = 0\) \{$/m.test(js) && /^function char_code\(s\) \{$/m.test(js);
  const out = js.replace(re, (whole, name: string, ps: string, body: string) => {
    if (ps.replace(/\s/g, "") !== "$0,$1,$2" || norm(body) !== ORDER_GO_EXPECTED) {
      skipped.push({ name, reason: "body is not the text this bend version emits for Base's String.order.go" });
      return whole;
    }
    if (!helpers) {
      skipped.push({ name, reason: "the runtime's char_len(s, at) and char_code(s) are not in the module" });
      return whole;
    }
    native.push({ name });
    return ORDER_GO_NATIVE;
  });
  return { js: out, native, skipped };
}
