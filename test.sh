#!/bin/sh
# bend-emit's gate: the tool on six fixture cores.
#
#   1. each fixture checks, and the tool builds it into a typed module
#   2. the tests pass: the .d.ts text, the refusals, the values at run time
#   3. the source and a host written against the generated types typecheck
#
# Usage: sh test.sh

set -e
cd "$(dirname "$0")"

# The installed compiler, wherever it is.
PATH="$HOME/.bend/bin:$PATH"
export PATH
BEND_NO_TELEMETRY=1
export BEND_NO_TELEMETRY

echo "== 1. the modules =="
# Each test file imports the module built from its fixture, so build them
# beside the tests first -- gitignored: nothing here is published.
for f in generics uses templated dependent dependent_user strings; do
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

echo "PASS: bend-emit's gate"
