#!/bin/zsh
cd /Users/ycn/Desktop/轮虫协议/playground
NODE="/Users/ycn/.nvm/versions/node/v22.19.0/bin/node"
S="/Users/ycn/.cursor/skills"

wrap_publish() {
  local name="$1" domain="$2" path="$3"
  echo -n "$name ($domain) ... "
  if $NODE dist/index.js wrap "$name" --from-skill "$path" --domain "$domain" > /dev/null 2>&1; then
    echo -n "wrapped → "
  else
    echo "FAIL (wrap)"
    return 1
  fi
  if $NODE dist/index.js publish "$name" > /dev/null 2>&1; then
    echo "published ✓"
  else
    echo "FAIL (publish)"
    return 1
  fi
}

echo "=== Gene Cold-Start (37 skills) ==="
echo ""

wrap_publish "brand-personality" "ui.branding" "$S/brand-personality/SKILL.md"
wrap_publish "uiux-designer" "ui.design" "$S/uiux-designer/SKILL.md"
wrap_publish "ai-components" "ui.ai" "$S/ai-components/SKILL.md"
wrap_publish "web3-components" "ui.web3" "$S/web3-components/SKILL.md"
wrap_publish "auto-writer" "content.automation" "$S/auto-writer/SKILL.md"
wrap_publish "academic-writer" "content.academic" "$S/academic-writer/SKILL.md"
wrap_publish "business-writer" "content.business" "$S/business-writer/SKILL.md"
wrap_publish "creative-writer" "content.creative" "$S/creative-writer/SKILL.md"
wrap_publish "copywriter" "content.marketing" "$S/copywriter/SKILL.md"
wrap_publish "translator" "content.translation" "$S/translator/SKILL.md"
wrap_publish "grammar-checker" "content.grammar" "$S/grammar-checker/SKILL.md"
wrap_publish "style-optimizer" "content.style" "$S/style-optimizer/SKILL.md"
wrap_publish "readability-analyzer" "content.readability" "$S/readability-analyzer/SKILL.md"
wrap_publish "tone-analyzer" "content.tone" "$S/tone-analyzer/SKILL.md"
wrap_publish "plagiarism-checker" "content.integrity" "$S/plagiarism-checker/SKILL.md"
wrap_publish "citation-manager" "content.citation" "$S/citation-manager/SKILL.md"
wrap_publish "fact-checker" "content.factcheck" "$S/fact-checker/SKILL.md"
wrap_publish "seo-optimizer" "content.seo" "$S/seo-optimizer/SKILL.md"
wrap_publish "auto-coder" "code.automation" "$S/auto-coder/SKILL.md"
wrap_publish "logic-architect" "code.architecture" "$S/logic-architect/SKILL.md"
wrap_publish "api-designer" "code.api" "$S/api-designer/SKILL.md"
wrap_publish "data-modeler" "code.database" "$S/data-modeler/SKILL.md"
wrap_publish "testing-strategist" "code.testing" "$S/testing-strategist/SKILL.md"
wrap_publish "tech-lead" "code.quality" "$S/tech-lead/SKILL.md"
wrap_publish "security-auditor" "code.security" "$S/security-auditor/SKILL.md"
wrap_publish "debugger" "code.debug" "$S/debugger/SKILL.md"
wrap_publish "performance-optimizer" "code.performance" "$S/performance-optimizer/SKILL.md"
wrap_publish "devops-automator" "devops.cicd" "$S/devops-automator/SKILL.md"
wrap_publish "git-workflow" "devops.git" "$S/git-workflow/SKILL.md"
wrap_publish "docs-writer" "docs.technical" "$S/docs-writer/SKILL.md"
wrap_publish "doc-coauthoring" "docs.collaboration" "$S/doc-coauthoring/SKILL.md"
wrap_publish "product-manager" "product.management" "$S/product-manager/SKILL.md"
wrap_publish "project-reviewer" "product.review" "$S/project-reviewer/SKILL.md"
wrap_publish "prompt-engineer" "ai.prompting" "$S/prompt-engineer/SKILL.md"
wrap_publish "algorithmic-art" "creative.generative" "$S/algorithmic-art/SKILL.md"
wrap_publish "license-advisor" "legal.licensing" "$S/license-advisor/SKILL.md"
wrap_publish "orch" "orchestration.dispatch" "$S/orch/SKILL.md"

echo ""
echo "=== Done ==="
