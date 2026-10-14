// A host written against the generated types; test.sh requires tsc to accept
// it, and to reject each line marked @ts-expect-error.

import { sum_or_err, type BendResult, type Err } from "./dist/generics.mjs";
import { empty, insert, lookup, type BendMap } from "./dist/maps.mjs";

// Every error is handled: remove a case and `never` fails to typecheck.
export function describe(r: BendResult<Err, number>): string {
  switch (r.$) {
    case "Done":
      return `total ${r.value}`;
    case "Fail": {
      const e = r.error;
      switch (e.$) {
        case "Empty":
          return "no numbers";
        case "TooBig":
          return `number ${e.index} is ${e.got}, too big`;
        default: {
          const unreachable: never = e;
          return unreachable;
        }
      }
    }
  }
}

export const ok = describe(sum_or_err({ $: "Nil" }, 1));

export const mapOk = lookup(insert(empty(), "ok", 8), "ok", 0);

// @ts-expect-error a Map position is a number, not a bigint
export const wrongMapPosition: BendMap<number> = { $: "MNode", pos: 1n, lo: { $: "MTip" }, hi: { $: "MTip" } };

// @ts-expect-error a Done carries `value`, not `error`
export const wrongField: BendResult<Err, number> = { $: "Done", error: { $: "Empty" } };
// @ts-expect-error a Nat is a number, not a bigint
export const wrongNumber: BendResult<Err, number> = { $: "Done", value: 3n };

// Defs named like runtime functions are named exports; a def named with a
// reserved word is reached through the default export only.
import names, { message, run_lib } from "./dist/runtime_names.mjs";
export const runtimeNamed: [number, string, number] = [run_lib(1), message(), names.class(2)];
import { core } from "./dist/runtime_names.mjs";
export const namedCore: number = core(3);
