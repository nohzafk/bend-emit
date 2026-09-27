// The calls the generated types must reject. test.sh compiles this on its own
// and expects tsc to FAIL with TS2345 on both, so it is deliberately not part
// of test/tsconfig.json, where a rejection would be a failed gate.
//
// The point is that the .mjs module's types are read at all: tsc resolves
// ./dist/generics.mjs to ./dist/generics.d.mts (measured with --traceResolution)
// and then refuses these. If the declaration were not found the import would be
// `any`, both calls would typecheck, and this file would pass -- which is why
// the gate reads "tsc accepted the wrong calls" as a failure.

import { sum_or_err, type BendList } from "./dist/generics.mjs";

const numbers: BendList<bigint> = { $: "Nil" };

// A Nat is a bigint; a BendList is a tagged list, not a string.
export const wrong = sum_or_err("not a list", 5n);

// The second parameter is a Nat, so a JS number is wrong too.
export const also_wrong = sum_or_err(numbers, 5);
