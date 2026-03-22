#!/bin/bash
set -e

ENDPOINT="${SUPABASE_URL:?Missing SUPABASE_URL environment variable}"
ANON_KEY="${SUPABASE_ANON_KEY:?Missing SUPABASE_ANON_KEY environment variable}"
ACCESS_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.rotifer/credentials.json')); print(d['access_token'])")
GENES_DIR="$(cd "$(dirname "$0")/../genes" && pwd)"

GENES=("readability-analyzer" "grammar-checker" "citation-manager" "design-tokens" "seo-optimizer")

echo "Republishing 5 Native Genes to Cloud Registry..."
echo ""

SUCCESS=0
for gene in "${GENES[@]}"; do
  PHENOTYPE=$(cat "$GENES_DIR/$gene/phenotype.json")
  README=$(python3 -c "
import json, sys
with open('$GENES_DIR/$gene/SKILL.md') as f:
    readme = f.read()
phenotype = json.loads('''$PHENOTYPE''')
body = {
    'fidelity': 'Native',
    'version': '0.2.0',
    'description': phenotype['description'],
    'phenotype': phenotype,
    'readme': readme
}
print(json.dumps(body))
" 2>/dev/null)

  RESULT=$(curl -s -w "\n%{http_code}" -X PATCH \
    "$ENDPOINT/rest/v1/genes?name=eq.$gene" \
    -H "Content-Type: application/json" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Prefer: return=representation" \
    -d "$README" 2>/dev/null)

  HTTP_CODE=$(echo "$RESULT" | tail -1)
  BODY=$(echo "$RESULT" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  OK   $gene -> v0.2.0 fidelity=Native"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  FAIL $gene: HTTP $HTTP_CODE"
    echo "       $BODY" | head -2
  fi
done

echo ""
echo "Done: $SUCCESS/${#GENES[@]} genes updated."
