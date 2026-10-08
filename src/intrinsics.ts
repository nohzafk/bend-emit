// intrinsics.ts: replace a Base def whose emitted JavaScript is correct but
// unusable at scale with a native equivalent.
//
// Base's String.cmp walks two strings one character at a time through
// String.cmp.fin, which calls String.cmp again. The two call each other, so
// the loop pass (which sees only self-calls) cannot turn them into a loop: a
// comparison costs two JavaScript frames per equal leading character, and each
// step slices a new tail string, so two keys sharing a long prefix throw
// RangeError and cost time quadratic in that prefix. Every String.eq,
// String.order and String.is_* goes through it.
//
// The native String.cmp returns the same value: the pair of its two inputs and
// their order. A Bend String is a list of Char, one per code point, so the order
// is lexicographic by code point -- not JavaScript's `<`, which compares UTF-16
// code units and orders a character above U+FFFF below one in U+E000..U+FFFF.
// A lone surrogate is one Char, as in bend's own head expression.
//
// The replacement happens only when the def is exactly the text this bend
// version emits; any other text is left alone and reported.

export interface Native { name: string }
export interface Skipped { name: string; reason: string }

// The body bend 2.0.35 emits for Base's String.cmp, with blank-insensitive
// comparison done by the caller.
const CMP_EXPECTED = [
  'if (_a_0 === "") {',
  'if (_b_0 === "") {',
  'return {$: "Tuple", "fst": {$: "Tuple", "fst": "", "snd": ""}, "snd": {$: "EQ"}};',
  "} else {",
  "const _h_0 = (_b_0.codePointAt(0) > 0xFFFF ? _b_0.slice(0, 2) : _b_0[0]);",
  "const _t_0 = (_b_0.codePointAt(0) > 0xFFFF ? _b_0.slice(2) : _b_0.slice(1));",
  'return {$: "Tuple", "fst": {$: "Tuple", "fst": "", "snd": (_h_0 + _t_0)}, "snd": {$: "LT"}};',
  "}",
  "} else {",
  "const _h_1 = (_a_0.codePointAt(0) > 0xFFFF ? _a_0.slice(0, 2) : _a_0[0]);",
  "const _t_1 = (_a_0.codePointAt(0) > 0xFFFF ? _a_0.slice(2) : _a_0.slice(1));",
  'if (_b_0 === "") {',
  'return {$: "Tuple", "fst": {$: "Tuple", "fst": (_h_1 + _t_1), "snd": ""}, "snd": {$: "GT"}};',
  "} else {",
  "const _h2_0 = (_b_0.codePointAt(0) > 0xFFFF ? _b_0.slice(0, 2) : _b_0[0]);",
  "const _t2_0 = (_b_0.codePointAt(0) > 0xFFFF ? _b_0.slice(2) : _b_0.slice(1));",
  "return $String$cmp$fin$(_t_1, _t2_0, ($Char$cmp$(_h_1, _h2_0)));",
  "}",
  "}",
].join("\n");

const CMP_NATIVE = [
  "function $String$cmp$(_a_0, _b_0) {",
  "  const o = $str_order$(_a_0, _b_0);",
  '  return {$: "Tuple", "fst": {$: "Tuple", "fst": _a_0, "snd": _b_0}, "snd": (o < 0 ? {$: "LT"} : o > 0 ? {$: "GT"} : {$: "EQ"})};',
  "}",
].join("\n");

const ORDER = [
  "// bend-emit: Base's String.cmp order, natively: lexicographic by code point (-1, 0, 1).",
  "function $str_order$(a, b) {",
  "  if (a === b) return 0;",
  "  let i = 0, j = 0;",
  "  for (;;) {",
  "    if (i >= a.length) return j >= b.length ? 0 : -1;",
  "    if (j >= b.length) return 1;",
  "    const x = a.codePointAt(i), y = b.codePointAt(j);",
  "    if (x !== y) return x < y ? -1 : 1;",
  "    i += x > 0xFFFF ? 2 : 1;",
  "    j += y > 0xFFFF ? 2 : 1;",
  "  }",
  "}",
  "",
].join("\n");

const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

export function intrinsics(js: string): { js: string; native: Native[]; skipped: Skipped[] } {
  const native: Native[] = [], skipped: Skipped[] = [];
  let helper = false;
  const re = /^function (\$String\$cmp\$)\(([^)]*)\) \{\n([\s\S]*?)\n\}$/m;
  const out = js.replace(re, (whole, name: string, ps: string, body: string) => {
    if (ps.replace(/\s/g, "") !== "_a_0,_b_0" || norm(body) !== CMP_EXPECTED) {
      skipped.push({ name, reason: "body is not the text this bend version emits for Base's String.cmp" });
      return whole;
    }
    native.push({ name });
    helper = true;
    return CMP_NATIVE;
  });
  return { js: helper ? out.replace(/^function /m, () => ORDER + "function ") : out, native, skipped };
}
