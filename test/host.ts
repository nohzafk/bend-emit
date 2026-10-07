// A host written against the generated types; test.sh requires tsc to accept
// it, and to reject each line marked @ts-expect-error.

import { sum_or_err, type BendResult, type Err } from "./dist/generics.mjs";
import { empty, insert, lookup, type BendMap } from "./dist/maps.mjs";

// Every error is handled: remove a case and `never` fails to typecheck.
export function describe(r: BendResult<Err, bigint>): string {
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

export const ok = describe(sum_or_err({ $: "Nil" }, 1n));

export const mapOk = lookup(insert(empty(), "ok", 8n), "ok", 0n);

// @ts-expect-error a Map position is a bigint, not a number
export const wrongMapPosition: BendMap<bigint> = { $: "MNode", pos: 1, lo: { $: "MTip" }, hi: { $: "MTip" } };

// @ts-expect-error a Done carries `value`, not `error`
export const wrongField: BendResult<Err, bigint> = { $: "Done", error: { $: "Empty" } };
// @ts-expect-error a Nat is a bigint, not a number
export const wrongNumber: BendResult<Err, bigint> = { $: "Done", value: 3 };
