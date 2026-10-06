#!/bin/sh
# bend-emit's gate: the tool on six fixture cores.
#
#   1. each fixture checks, and the tool builds it into a typed module
#   2. the tests pass: the .d.mts text, the refusals, the values at run time
#   3. the source and a host written against the generated types typecheck
#   4. node loads a built module under both package modes
#
# Usage: sh test.sh

set -e
cd "$(dirname "$0")"

# The bend this tool declares (BEND_VERSION): the one in
# ~/projects/.toolchains/bend-<v>/ if it is there, else the installed one. The
# tool refuses any other version, and so does this gate, before anything runs.
BEND_VERSION=$(tr -d ' \t\n\r' < BEND_VERSION)
PATH="${BEND_TOOLCHAINS:-$HOME/projects/.toolchains}/bend-$BEND_VERSION/bin:$HOME/.bend/bin:$PATH"
export PATH
if [ "$(bend version 2>/dev/null)" != "bend $BEND_VERSION" ]; then
  echo "FAIL: this gate needs bend $BEND_VERSION; bend on PATH says: $(bend version 2>&1)"
  exit 1
fi
BEND_NO_TELEMETRY=1
export BEND_NO_TELEMETRY

echo "== 1. the modules =="
# Each test file imports the module built from its fixture, so build them
# beside the tests first -- gitignored: nothing here is published. dist/ is
# emptied first so a stale .js from an earlier layout cannot pass for a .mjs.
rm -rf test/dist
for f in generics uses reuses templated dependent dependent_user chars; do
  tools/bend-check "test/$f.bend"
  bun src/emit.ts "test/$f.bend" test/dist > /dev/null
  echo "  $f: built"
done

echo "== 2. the tests =="
if ! bun test > /tmp/bend-emit-tests.log 2>&1; then
  tail -30 /tmp/bend-emit-tests.log
  echo "FAIL: a test failed"
  exit 1
fi
tail -3 /tmp/bend-emit-tests.log

echo "== 3. the types =="
bunx tsc -p .
# the fixture host, against the modules the fixtures just built
bunx tsc -p test

# ...and the calls it must refuse. test/rejected.ts is compiled on its own and
# is expected to FAIL: the point is that a wrong call to a .mjs module is caught
# through the .d.mts beside it, and not silently `any`.
if bunx tsc -p test/tsconfig.rejected.json > /tmp/bend-emit-rejected.log 2>&1; then
  echo "FAIL: tsc accepted the wrong calls -- the declaration is not being resolved"
  exit 1
fi
# Both rejections are the types'; any other error is a host that does not
# compile for its own sake and would prove nothing.
if ! grep -q "TS2345" /tmp/bend-emit-rejected.log; then
  cat /tmp/bend-emit-rejected.log
  echo "FAIL: no TS2345 -- the rejection is not the one the types make"
  exit 1
fi
sed 's/^/  /' /tmp/bend-emit-rejected.log

echo "== 4. node loads it, under both package modes =="
# The module is ESM, whatever the file is called: a .js file's module system
# comes from the nearest package.json "type", so under "type": "commonjs" the
# old core.js failed to load with "SyntaxError: Unexpected token 'export'".
# Every consumer here works on bun, which defaults to ESM, so nothing caught it.
# .mjs is ESM in every package mode, which is what this checks. Not skippable:
# its absence is how the bug got in.
NODE_TMP=$(mktemp -d)
trap 'rm -rf "$NODE_TMP"' EXIT
for mode in commonjs module; do
  printf '{ "type": "%s" }\n' "$mode" > "$NODE_TMP/package.json"
  # A named import and the default, so a module that loads but exports nothing
  # is not a pass either.
  cat > "$NODE_TMP/load.mjs" <<'LOADER'
import { sum_or_err } from "./generics.mjs";
import generics from "./generics.mjs";
if (typeof sum_or_err !== "function") throw new Error("no named export");
if (generics.sum_or_err !== sum_or_err) throw new Error("default is bend's own object");
console.log("  loaded, named export and default both there");
LOADER
  cp test/dist/generics.mjs test/dist/generics.d.mts "$NODE_TMP/"
  echo "  type: $mode"
  if ! node "$NODE_TMP/load.mjs" > "$NODE_TMP/out" 2>&1; then
    cat "$NODE_TMP/out"
    echo "FAIL: node could not load the emitted module under type: $mode"
    exit 1
  fi
  cat "$NODE_TMP/out"
done

echo "== 5. another bend is refused =="
# A fake bend first on PATH that answers another version: the tool must stop
# before it compiles anything, naming both versions.
FAKE=$(mktemp -d)
printf '#!/bin/sh\necho "bend 2.0.0"\n' > "$FAKE/bend"
chmod +x "$FAKE/bend"
if PATH="$FAKE:$PATH" bun src/emit.ts test/generics.bend "$FAKE/out" > "$FAKE/log" 2>&1; then
  echo "FAIL: the tool built a module with bend 2.0.0"
  exit 1
fi
if ! grep -q "needs bend $BEND_VERSION" "$FAKE/log" || ! grep -q "bend 2.0.0" "$FAKE/log"; then
  cat "$FAKE/log"
  echo "FAIL: the refusal does not name both versions"
  exit 1
fi
sed 's/^/  /' "$FAKE/log"
rm -rf "$FAKE"

echo "PASS: bend-emit's gate"
