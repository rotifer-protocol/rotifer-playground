#!/usr/bin/env bash
# Smoke-test the package npm would publish, not the source checkout.
#
# Why: `hello --template quality-advisor` — the first command the README and
# the `init` banner recommend — failed on every published version since 0.30.0
# (#453). `init` copies gene-health-scanner out of the package's genes/, but
# genes/.npmignore kept it out of the tarball. Every test ran on the checkout,
# where the gene exists, so nothing caught it. This script packs the checkout,
# installs the tarball into an empty directory and runs the first-run path
# from there.
#
# Trap it avoids: a global `npm link` of this package (common on dev machines)
# makes `npx @rotifer/playground` and a bare `rotifer` run the checkout
# silently. Everything below calls the installed binary by absolute path and
# asserts that path resolves inside the temp directory.
#
# stdin is /dev/null for every CLI call: `hello` reads input from a non-TTY
# stdin and would otherwise wait for an EOF that never comes.
#
# Usage: npm run build && bash scripts/smoke-packed-package.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "::error::$*" >&2; exit 1; }

[ -f "$REPO/dist/index.js" ] || fail "dist/ is missing — run 'npm run build' first"

echo "── pack"
TGZ="$(cd "$REPO" && npm pack --ignore-scripts --silent --pack-destination "$WORK" | tail -1)"
echo "  $TGZ"

# Every gene `init` copies must be in the tarball. The lists are read from
# init.ts itself so a gene added there is checked here without editing this file.
echo "── genes init copies, present in the tarball"
GENES="$(node -e '
  const src = require("fs").readFileSync(process.argv[1], "utf8");
  const names = [];
  for (const list of ["GENESIS_GENES", "RECOMMENDED_TEMPLATE_GENES"]) {
    const m = src.match(new RegExp("const " + list + " = \\[([^\\]]*)\\]"));
    if (!m) { console.error("cannot find " + list + " in init.ts"); process.exit(1); }
    for (const q of m[1].matchAll(/"([^"]+)"/g)) names.push(q[1]);
  }
  console.log(names.join(" "));
' "$REPO/src/commands/init.ts")"
CONTENTS="$(tar -tzf "$WORK/$TGZ")"
for gene in $GENES; do
  if grep -qx "package/genes/$gene/phenotype.json" <<<"$CONTENTS"; then
    echo "  ok  $gene"
  else
    fail "genes/$gene is not in the package — init copies it from there (check genes/.npmignore)"
  fi
done

echo "── install the tarball into an empty project"
mkdir -p "$WORK/app" "$WORK/home"
export HOME="$WORK/home" DO_NOT_TRACK=1 ROTIFER_TELEMETRY=0 NO_COLOR=1
(cd "$WORK/app" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error "$WORK/$TGZ" >/dev/null)

BIN="$WORK/app/node_modules/.bin/rotifer"
REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$BIN")"
case "$REAL" in
  "$WORK"/*) echo "  rotifer -> $REAL" ;;
  *) fail "rotifer resolves to $REAL, outside the test directory — a global link is shadowing the package" ;;
esac

echo "── init"
(cd "$WORK" && "$BIN" init demo --plain </dev/null)

echo "── hello --template quality-advisor (the recommended first command)"
(cd "$WORK/demo" && "$BIN" hello --template quality-advisor --plain </dev/null)

echo "✓ the packed package runs the first-run path"
