#!/bin/zsh
# Gene Cold-Start: Batch wrap + publish skills as Wrapped genes
# Usage: cd playground && zsh scripts/cold-start.sh

set -uo pipefail

CLI="node dist/index.js"
SKILLS_DIR="$HOME/.cursor/skills"
LOG_FILE="scripts/cold-start.log"

> "$LOG_FILE"

skills=(
  "design-tokens|ui.design"
  "ui-components|ui.components"
  "ux-patterns|ux.interaction"
  "brand-personality|ui.branding"
  "uiux-designer|ui.design"
  "ai-components|ui.ai"
  "web3-components|ui.web3"
  "auto-writer|content.automation"
  "academic-writer|content.academic"
  "business-writer|content.business"
  "creative-writer|content.creative"
  "copywriter|content.marketing"
  "translator|content.translation"
  "grammar-checker|content.grammar"
  "style-optimizer|content.style"
  "readability-analyzer|content.readability"
  "tone-analyzer|content.tone"
  "plagiarism-checker|content.integrity"
  "citation-manager|content.citation"
  "fact-checker|content.factcheck"
  "seo-optimizer|content.seo"
  "auto-coder|code.automation"
  "logic-architect|code.architecture"
  "api-designer|code.api"
  "data-modeler|code.database"
  "testing-strategist|code.testing"
  "tech-lead|code.quality"
  "security-auditor|code.security"
  "debugger|code.debug"
  "performance-optimizer|code.performance"
  "devops-automator|devops.cicd"
  "git-workflow|devops.git"
  "docs-writer|docs.technical"
  "doc-coauthoring|docs.collaboration"
  "product-manager|product.management"
  "project-reviewer|product.review"
  "prompt-engineer|ai.prompting"
  "algorithmic-art|creative.generative"
  "license-advisor|legal.licensing"
  "orch|orchestration.dispatch"
)

total=${#skills[@]}
success=0
failed=0
skipped=0

echo "=== Gene Cold-Start ==="
echo "Source: $SKILLS_DIR"
echo "Total skills: $total"
echo ""

for entry in "${skills[@]}"; do
  skill="${entry%%|*}"
  domain="${entry##*|}"
  skill_path="$SKILLS_DIR/$skill/SKILL.md"

  if [ ! -f "$skill_path" ]; then
    echo "SKIP  $skill (SKILL.md not found)"
    ((skipped++))
    continue
  fi

  gene_name="$skill"

  echo -n "[$((success+failed+skipped+1))/$total] $gene_name ($domain) ... "

  if $CLI wrap "$gene_name" --from-skill "$skill_path" --domain "$domain" >> "$LOG_FILE" 2>&1; then
    echo -n "wrapped → "
  else
    echo "FAIL (wrap)"
    echo "FAIL  $gene_name wrap" >> "$LOG_FILE"
    ((failed++))
    continue
  fi

  if $CLI publish "$gene_name" >> "$LOG_FILE" 2>&1; then
    echo "published ✓"
    echo "OK    $gene_name → $domain" >> "$LOG_FILE"
    ((success++))
  else
    echo "FAIL (publish)"
    echo "FAIL  $gene_name publish" >> "$LOG_FILE"
    ((failed++))
  fi
done

echo ""
echo "=== Summary ==="
echo "Success: $success / $total"
echo "Failed:  $failed"
echo "Skipped: $skipped"
echo "Log: $LOG_FILE"
