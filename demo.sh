#!/usr/bin/env bash
#
# Rotifer Playground — Three-Act Demo (ADR-11)
#
# Act 1 (30s Wow):    rotifer init → Arena rankings instantly visible
# Act 2 (5min Aha):   scan → wrap → test → arena submit → see rankings
# Act 3 (30min Hooked): write native gene → compile → submit → agent create
#
set -euo pipefail

CLI="node $(dirname "$0")/dist/index.js"
DEMO_DIR="/tmp/rotifer-demo-$$"
DIVIDER="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

pause() {
  echo ""
  echo "  Press Enter to continue to the next act..."
  read -r
}

cleanup() {
  rm -rf "$DEMO_DIR"
}
trap cleanup EXIT

echo ""
echo "$DIVIDER"
echo "  ROTIFER PLAYGROUND — THREE-ACT DEMO"
echo "  Following ADR-11: Developer Experience Strategy"
echo "$DIVIDER"
echo ""

# ═══════════════════════════════════════════════
# ACT 1 — WOW (30 seconds)
# ═══════════════════════════════════════════════
echo "┌─────────────────────────────────────────────┐"
echo "│  ACT 1 — WOW (30 seconds)                   │"
echo "│  One command to see a living Arena            │"
echo "└─────────────────────────────────────────────┘"
echo ""
echo "  \$ rotifer init $DEMO_DIR"
echo ""

$CLI init "$DEMO_DIR"

pause

# ═══════════════════════════════════════════════
# ACT 2 — AHA (5 minutes)
# ═══════════════════════════════════════════════
echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  ACT 2 — AHA (5 minutes)                    │"
echo "│  Wrap existing code → submit to Arena         │"
echo "└─────────────────────────────────────────────┘"
echo ""

cd "$DEMO_DIR"

echo "  \$ rotifer scan genes/"
echo ""
$CLI scan genes/

echo ""
echo "  \$ rotifer wrap hello-world --domain general"
echo ""
$CLI wrap hello-world --domain general

echo ""
echo "  \$ rotifer test hello-world"
echo ""
$CLI test hello-world

echo ""
echo "  \$ rotifer arena submit hello-world"
echo ""
$CLI arena submit hello-world

echo ""
echo "  \$ rotifer arena list"
echo ""
$CLI arena list

pause

# ═══════════════════════════════════════════════
# ACT 3 — HOOKED (30 minutes)
# ═══════════════════════════════════════════════
echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  ACT 3 — HOOKED (30 minutes)                │"
echo "│  Write a native gene → compete in Arena       │"
echo "└─────────────────────────────────────────────┘"
echo ""

echo "  Creating a custom native search gene..."
echo ""

mkdir -p "$DEMO_DIR/genes/my-native-search"

cat > "$DEMO_DIR/genes/my-native-search/phenotype.json" << 'PHENOTYPE'
{
  "domain": "search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "maxResults": { "type": "integer", "default": 5 }
    },
    "required": ["query"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "results": { "type": "array" },
      "count": { "type": "integer" },
      "latencyMs": { "type": "number" }
    }
  },
  "version": "0.1.0",
  "fidelity": "Native",
  "transparency": "Open",
  "semantic_requirements": {
    "timeModel": "Async",
    "concurrencyModel": "Stateless",
    "failureSemantics": "Retry"
  }
}
PHENOTYPE

cat > "$DEMO_DIR/genes/my-native-search/index.ts" << 'GENECODE'
interface SearchInput {
  query: string;
  maxResults?: number;
}

interface SearchOutput {
  results: { title: string; url: string; relevance: number }[];
  count: number;
  latencyMs: number;
}

export async function express(input: SearchInput): Promise<SearchOutput> {
  const start = Date.now();
  const max = input.maxResults ?? 5;

  const results = Array.from({ length: max }, (_, i) => ({
    title: `[Native] Result ${i + 1} for "${input.query}"`,
    url: `https://search.rotifer.dev/q/${encodeURIComponent(input.query)}&p=${i + 1}`,
    relevance: 0.95 - i * 0.08,
  }));

  return {
    results,
    count: results.length,
    latencyMs: Date.now() - start,
  };
}
GENECODE

echo "  \$ rotifer compile my-native-search"
echo ""
$CLI compile my-native-search

echo ""
echo "  \$ rotifer test my-native-search"
echo ""
$CLI test my-native-search

echo ""
echo "  \$ rotifer arena submit my-native-search"
echo ""
$CLI arena submit my-native-search

echo ""
echo "  \$ rotifer arena list --domain search"
echo ""
$CLI arena list --domain search

echo ""
echo "  Creating an Agent with a search-focused genome..."
echo ""
echo "  \$ rotifer agent create search-agent --genes genesis-web-search my-native-search"
echo ""
$CLI agent create search-agent --genes genesis-web-search my-native-search

echo ""
echo "  \$ rotifer agent list"
echo ""
$CLI agent list

echo ""
echo "$DIVIDER"
echo "  DEMO COMPLETE"
echo ""
echo "  Act 1: Saw a living Arena in < 30 seconds"
echo "  Act 2: Wrapped existing code → submitted to Arena"
echo "  Act 3: Built a native gene → competed → created an Agent"
echo ""
echo "  The Rotifer Protocol is alive."
echo "$DIVIDER"
echo ""
