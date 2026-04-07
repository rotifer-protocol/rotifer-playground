interface AnalyzerInput {
  html: string;
  css?: string;
  format?: "summary" | "detailed";
}

interface Violation {
  rule: string;
  severity: "critical" | "warning" | "info";
  message: string;
  category: "accessibility" | "visual" | "semantics" | "consistency";
}

interface AnalyzerOutput {
  score: number;
  violations: Violation[];
  warnings: Violation[];
  passed: number;
  total: number;
  categories: {
    accessibility: number;
    visual: number;
    semantics: number;
    consistency: number;
  };
}

function checkHtmlRules(html: string): Violation[] {
  const violations: Violation[] = [];
  const lower = html.toLowerCase();

  if (/<html\b/i.test(html) && !/<html[^>]+lang\s*=/i.test(html)) {
    violations.push({
      rule: "html-lang",
      severity: "critical",
      message: "Missing lang attribute on <html> element (WCAG 3.1.1)",
      category: "accessibility",
    });
  } else if (!/<html\b/i.test(html)) {
    violations.push({
      rule: "html-lang",
      severity: "critical",
      message: "No <html> element found; lang attribute is required (WCAG 3.1.1)",
      category: "accessibility",
    });
  }

  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) {
    violations.push({
      rule: "meta-viewport",
      severity: "critical",
      message: "Missing <meta name=\"viewport\"> for responsive design",
      category: "accessibility",
    });
  }

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const imgsWithoutAlt = imgTags.filter((tag) => !/\balt\s*=/i.test(tag));
  if (imgsWithoutAlt.length > 0) {
    violations.push({
      rule: "img-alt",
      severity: "critical",
      message: `${imgsWithoutAlt.length} <img> tag(s) missing alt attribute (WCAG 1.1.1)`,
      category: "accessibility",
    });
  }

  const inputs = html.match(/<input\b[^>]*>/gi) || [];
  const inputsNeedingLabel = inputs.filter((tag) => {
    const typeMatch = tag.match(/type\s*=\s*["'](\w+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
    return !/aria-label\s*=/i.test(tag) && !/aria-labelledby\s*=/i.test(tag) && !/id\s*=/i.test(tag);
  });
  const labelFors = (html.match(/<label[^>]+for\s*=\s*["']([^"']+)["']/gi) || []).length;
  if (inputsNeedingLabel.length > 0 || (inputs.length > 0 && labelFors === 0 && inputs.some((t) => {
    const tm = t.match(/type\s*=\s*["'](\w+)["']/i);
    const tp = tm ? tm[1].toLowerCase() : "text";
    return !["hidden", "submit", "button", "reset", "image"].includes(tp);
  }))) {
    violations.push({
      rule: "input-label",
      severity: "critical",
      message: "Form <input> elements missing associated <label> or ARIA label (WCAG 1.3.1)",
      category: "accessibility",
    });
  }

  const headings = html.match(/<h([1-6])\b/gi) || [];
  if (headings.length === 0 && lower.includes("<body")) {
    violations.push({
      rule: "heading-structure",
      severity: "warning",
      message: "No heading elements found; page should have at least one <h1>",
      category: "semantics",
    });
  } else if (headings.length > 0) {
    const levels = headings.map((h) => parseInt(h.charAt(2), 10));
    if (!levels.includes(1)) {
      violations.push({
        rule: "heading-structure",
        severity: "warning",
        message: "Missing <h1> element; every page should have a primary heading",
        category: "semantics",
      });
    }
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        violations.push({
          rule: "heading-skip",
          severity: "warning",
          message: `Heading level skip detected: <h${levels[i - 1]}> → <h${levels[i]}> (WCAG 1.3.1)`,
          category: "semantics",
        });
        break;
      }
    }
  }

  const emptyHrefLinks = html.match(/<a\b[^>]*href\s*=\s*["'](#|)["'][^>]*>/gi) || [];
  if (emptyHrefLinks.length > 0) {
    violations.push({
      rule: "empty-link",
      severity: "warning",
      message: `${emptyHrefLinks.length} link(s) with empty or fragment-only href attribute`,
      category: "semantics",
    });
  }

  if (!/<main\b/i.test(html) && !/<[^>]+role\s*=\s*["']main["']/i.test(html)) {
    violations.push({
      rule: "main-landmark",
      severity: "warning",
      message: "Missing <main> landmark element (WCAG 1.3.1)",
      category: "semantics",
    });
  }

  const inlineStyles = html.match(/\bstyle\s*=\s*["'][^"']+["']/gi) || [];
  if (inlineStyles.length > 5) {
    violations.push({
      rule: "excessive-inline-styles",
      severity: "info",
      message: `${inlineStyles.length} inline style attributes found; prefer CSS classes for maintainability`,
      category: "consistency",
    });
  }

  let depth = 0;
  let maxDepth = 0;
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const full = match[0];
    const tagName = match[1].toLowerCase();
    if (voidElements.has(tagName) || full.endsWith("/>")) continue;
    if (full.startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  if (maxDepth > 10) {
    violations.push({
      rule: "deep-nesting",
      severity: "warning",
      message: `DOM nesting depth of ${maxDepth} exceeds recommended maximum of 10`,
      category: "semantics",
    });
  }

  const buttons = html.match(/<button\b[^>]*>/gi) || [];
  const buttonsWithoutType = buttons.filter((tag) => !/\btype\s*=/i.test(tag));
  if (buttonsWithoutType.length > 0) {
    violations.push({
      rule: "button-type",
      severity: "info",
      message: `${buttonsWithoutType.length} <button> element(s) missing explicit type attribute`,
      category: "semantics",
    });
  }

  const hasTables = /<table\b/i.test(html);
  if (hasTables && !/<th\b/i.test(html)) {
    violations.push({
      rule: "table-headers",
      severity: "warning",
      message: "Table(s) found without <th> header elements (WCAG 1.3.1)",
      category: "accessibility",
    });
  }

  const deprecatedTags = ["center", "font", "marquee", "blink"];
  const foundDeprecated = deprecatedTags.filter((tag) =>
    new RegExp(`<${tag}\\b`, "i").test(html)
  );
  if (foundDeprecated.length > 0) {
    violations.push({
      rule: "deprecated-tags",
      severity: "warning",
      message: `Deprecated HTML tag(s) found: <${foundDeprecated.join(">, <")}>`,
      category: "semantics",
    });
  }

  const mediaAutoplay = html.match(/<(video|audio)\b[^>]*\bautoplay\b[^>]*>/gi) || [];
  const unmutedAutoplay = mediaAutoplay.filter((tag) => !/\bmuted\b/i.test(tag));
  if (unmutedAutoplay.length > 0) {
    violations.push({
      rule: "autoplay-muted",
      severity: "critical",
      message: `${unmutedAutoplay.length} auto-playing media element(s) without muted attribute (WCAG 1.4.2)`,
      category: "accessibility",
    });
  }

  const tabindexMatches = html.match(/tabindex\s*=\s*["'](\d+)["']/gi) || [];
  const positiveTabindices = tabindexMatches.filter((t) => {
    const val = parseInt(t.match(/["'](\d+)["']/)?.[1] || "0", 10);
    return val > 0;
  });
  if (positiveTabindices.length > 0) {
    violations.push({
      rule: "tabindex-positive",
      severity: "warning",
      message: `${positiveTabindices.length} element(s) with tabindex > 0; this disrupts natural tab order`,
      category: "accessibility",
    });
  }

  const hasDynamicPatterns = /\bon(click|change|submit|input)\s*=/i.test(html) ||
    /addEventListener/i.test(html);
  if (hasDynamicPatterns) {
    const hasLiveRegion = /aria-live\s*=/i.test(html) || /role\s*=\s*["'](alert|status|log|timer)["']/i.test(html);
    if (!hasLiveRegion) {
      violations.push({
        rule: "aria-live-region",
        severity: "info",
        message: "Dynamic content detected but no ARIA live region found (aria-live or role=\"alert\")",
        category: "accessibility",
      });
    }
  }

  return violations;
}

function checkCssRules(css: string): Violation[] {
  const violations: Violation[] = [];

  const fontSizes = css.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi) || [];
  const smallFonts = fontSizes.filter((f) => {
    const size = parseFloat(f.match(/(\d+(?:\.\d+)?)\s*px/i)?.[1] || "16");
    return size < 12;
  });
  if (smallFonts.length > 0) {
    violations.push({
      rule: "min-font-size",
      severity: "warning",
      message: `${smallFonts.length} font-size declaration(s) below 12px minimum (WCAG 1.4.4)`,
      category: "accessibility",
    });
  }

  const lightBgColors = /background(?:-color)?\s*:\s*(white|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i;
  const darkBgColors = /background(?:-color)?\s*:\s*(black|#000(?:000)?|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/i;
  const hasLightFgOnLight = lightBgColors.test(css) &&
    /(?:^|[{;])\s*color\s*:\s*(#(?:ccc|ddd|eee|fff)|white|rgb\(\s*(?:2[0-5]\d|1\d\d)\s*,\s*(?:2[0-5]\d|1\d\d)\s*,\s*(?:2[0-5]\d|1\d\d)\s*\))/im.test(css);
  const hasDarkFgOnDark = darkBgColors.test(css) &&
    /(?:^|[{;])\s*color\s*:\s*(#(?:000|111|222|333)|black|rgb\(\s*(?:[0-5]\d)\s*,\s*(?:[0-5]\d)\s*,\s*(?:[0-5]\d)\s*\))/im.test(css);
  if (hasLightFgOnLight || hasDarkFgOnDark) {
    violations.push({
      rule: "contrast-ratio",
      severity: "critical",
      message: "Potential insufficient color contrast detected (WCAG 1.4.3)",
      category: "accessibility",
    });
  }

  const lineHeights = css.match(/line-height\s*:\s*(\d+(?:\.\d+)?)\s*(?:;|})/gi) || [];
  const tightLineHeights = lineHeights.filter((l) => {
    const val = parseFloat(l.match(/(\d+(?:\.\d+)?)/)?.[1] || "1.5");
    return val < 1.4 && val > 0;
  });
  if (tightLineHeights.length > 0) {
    violations.push({
      rule: "line-height",
      severity: "warning",
      message: `${tightLineHeights.length} line-height value(s) below 1.4 recommended minimum (WCAG 1.4.12)`,
      category: "visual",
    });
  }

  const importants = css.match(/!important/gi) || [];
  if (importants.length > 3) {
    violations.push({
      rule: "important-overuse",
      severity: "warning",
      message: `${importants.length} !important declarations found; indicates specificity conflicts`,
      category: "consistency",
    });
  }

  const hexColors = css.match(/#(?:[0-9a-f]{3,8})\b/gi) || [];
  const rgbColors = css.match(/rgba?\([^)]+\)/gi) || [];
  const uniqueColors = new Set([
    ...hexColors.map((c) => c.toLowerCase()),
    ...rgbColors.map((c) => c.toLowerCase().replace(/\s/g, "")),
  ]);
  if (uniqueColors.size > 7) {
    violations.push({
      rule: "color-palette",
      severity: "info",
      message: `${uniqueColors.size} distinct color values found; consider consolidating to a design token palette`,
      category: "consistency",
    });
  }

  const spacingValues = new Set<string>();
  const spacingPattern = /(?:margin|padding)(?:-(?:top|right|bottom|left))?\s*:\s*([^;{}]+)/gi;
  let spacingMatch: RegExpExecArray | null;
  while ((spacingMatch = spacingPattern.exec(css)) !== null) {
    const values = spacingMatch[1].trim().split(/\s+/);
    values.forEach((v) => spacingValues.add(v.toLowerCase()));
  }
  if (spacingValues.size > 5) {
    violations.push({
      rule: "spacing-consistency",
      severity: "info",
      message: `${spacingValues.size} distinct spacing values found; use a spacing scale for consistency`,
      category: "consistency",
    });
  }

  const hasMediaQueries = /@media\b/i.test(css);
  const fixedBreakpoints = css.match(/(?:min|max)-width\s*:\s*\d+px/gi) || [];
  if (fixedBreakpoints.length > 0 && !hasMediaQueries) {
    violations.push({
      rule: "fixed-breakpoints",
      severity: "info",
      message: "Fixed pixel breakpoints found without media queries for responsive design",
      category: "visual",
    });
  }

  const zIndexValues = new Set<string>();
  const zPattern = /z-index\s*:\s*(-?\d+)/gi;
  let zMatch: RegExpExecArray | null;
  while ((zMatch = zPattern.exec(css)) !== null) {
    zIndexValues.add(zMatch[1]);
  }
  if (zIndexValues.size > 5) {
    violations.push({
      rule: "z-index-chaos",
      severity: "warning",
      message: `${zIndexValues.size} distinct z-index values found; use a layering scale to prevent stacking conflicts`,
      category: "consistency",
    });
  }

  const hasFocusStyles = /:focus\b/i.test(css) || /:focus-visible\b/i.test(css);
  if (!hasFocusStyles) {
    violations.push({
      rule: "focus-styles",
      severity: "critical",
      message: "No :focus or :focus-visible styles found (WCAG 2.4.7)",
      category: "accessibility",
    });
  }

  const fontFamilies = css.match(/font-family\s*:/gi) || [];
  if (fontFamilies.length > 3) {
    violations.push({
      rule: "font-family-count",
      severity: "info",
      message: `${fontFamilies.length} font-family declarations found; limit to 2-3 for visual consistency`,
      category: "visual",
    });
  }

  const fixedWidths = css.match(/(?:^|[{;])\s*width\s*:\s*\d+px/gim) || [];
  const hasResponsiveUnits = /(?:vw|vh|%|rem|em|fr)\b/i.test(css);
  if (fixedWidths.length > 3 && !hasResponsiveUnits) {
    violations.push({
      rule: "fixed-widths",
      severity: "warning",
      message: `${fixedWidths.length} fixed pixel width declarations without responsive units`,
      category: "visual",
    });
  }

  if (!/@media\s*\(\s*prefers-reduced-motion/i.test(css)) {
    const hasAnimations = /animation|transition|@keyframes/i.test(css);
    if (hasAnimations) {
      violations.push({
        rule: "reduced-motion",
        severity: "warning",
        message: "Animations/transitions found but no prefers-reduced-motion media query (WCAG 2.3.3)",
        category: "accessibility",
      });
    }
  }

  const selectorDepths = css.match(/[^{}@]+(?=\s*\{)/g) || [];
  const deepSelectors = selectorDepths.filter((s) => {
    const parts = s.trim().split(/\s+/).filter((p) => /^[a-zA-Z.#\[:>+~]/.test(p));
    return parts.length > 4;
  });
  if (deepSelectors.length > 0) {
    violations.push({
      rule: "selector-depth",
      severity: "info",
      message: `${deepSelectors.length} selector(s) with depth > 4; prefer flat, composable selectors`,
      category: "consistency",
    });
  }

  const hasCustomProperties = /--[a-zA-Z][\w-]*\s*:/i.test(css);
  if (!hasCustomProperties && css.trim().length > 200) {
    violations.push({
      rule: "css-custom-properties",
      severity: "info",
      message: "No CSS custom properties (--var) found; design tokens improve maintainability",
      category: "consistency",
    });
  }

  const hasFloat = /float\s*:\s*(left|right)/i.test(css);
  const hasModernLayout = /display\s*:\s*(flex|grid)/i.test(css);
  if (hasFloat && !hasModernLayout) {
    violations.push({
      rule: "float-layout",
      severity: "info",
      message: "Using float-based layout; prefer flexbox or grid for modern responsive layouts",
      category: "visual",
    });
  }

  return violations;
}

function computeCategoryScores(
  violations: Violation[],
  htmlRuleCount: number,
  cssRuleCount: number
): { accessibility: number; visual: number; semantics: number; consistency: number } {
  const categoryTotals: Record<string, number> = {
    accessibility: 0,
    visual: 0,
    semantics: 0,
    consistency: 0,
  };
  const categoryFailed: Record<string, number> = {
    accessibility: 0,
    visual: 0,
    semantics: 0,
    consistency: 0,
  };

  const htmlCategoryMap: Record<string, string[]> = {
    accessibility: ["html-lang", "meta-viewport", "img-alt", "input-label", "table-headers", "autoplay-muted", "tabindex-positive", "aria-live-region"],
    visual: [],
    semantics: ["heading-structure", "heading-skip", "empty-link", "main-landmark", "deep-nesting", "button-type", "deprecated-tags"],
    consistency: ["excessive-inline-styles"],
  };

  const cssCategoryMap: Record<string, string[]> = {
    accessibility: ["min-font-size", "contrast-ratio", "focus-styles", "reduced-motion"],
    visual: ["line-height", "fixed-breakpoints", "font-family-count", "fixed-widths", "float-layout"],
    semantics: [],
    consistency: ["important-overuse", "color-palette", "spacing-consistency", "z-index-chaos", "selector-depth", "css-custom-properties"],
  };

  const categoryMap = cssRuleCount > 0
    ? Object.fromEntries(
        Object.keys(htmlCategoryMap).map((cat) => [
          cat,
          [...htmlCategoryMap[cat], ...cssCategoryMap[cat]],
        ])
      )
    : htmlCategoryMap;

  for (const [cat, rules] of Object.entries(categoryMap)) {
    categoryTotals[cat] = rules.length;
  }

  for (const v of violations) {
    if (v.category in categoryFailed) {
      categoryFailed[v.category]++;
    }
  }

  const scores: Record<string, number> = {};
  for (const cat of Object.keys(categoryTotals)) {
    const total = categoryTotals[cat];
    if (total === 0) {
      scores[cat] = 100;
    } else {
      const passed = Math.max(0, total - categoryFailed[cat]);
      scores[cat] = Math.round((passed / total) * 100);
    }
  }

  return scores as { accessibility: number; visual: number; semantics: number; consistency: number };
}

export function express(input: AnalyzerInput): AnalyzerOutput {
  if (!input?.html || typeof input.html !== "string") {
    return {
      score: 0,
      violations: [{
        rule: "missing-input",
        severity: "critical",
        message: "No HTML content provided. Pass an HTML string via the 'html' field.",
        category: "semantics",
      }],
      warnings: [],
      passed: 0,
      total: 0,
      categories: { accessibility: 0, visual: 0, semantics: 0, consistency: 0 },
    };
  }

  const htmlViolations = checkHtmlRules(input.html);
  const cssViolations = input.css ? checkCssRules(input.css) : [];
  const allViolations = [...htmlViolations, ...cssViolations];

  const htmlRuleCount = 15;
  const cssRuleCount = input.css ? 15 : 0;
  const totalRules = htmlRuleCount + cssRuleCount;

  const warnings = allViolations.filter((v) => v.severity === "warning");
  const passed = totalRules - allViolations.length;

  let score = 100;
  for (const v of allViolations) {
    switch (v.severity) {
      case "critical":
        score -= 5;
        break;
      case "warning":
        score -= 3;
        break;
      case "info":
        score -= 1;
        break;
    }
  }
  score = Math.max(0, score);

  const categories = computeCategoryScores(allViolations, htmlRuleCount, cssRuleCount);

  return {
    score,
    violations: allViolations,
    warnings,
    passed: Math.max(0, passed),
    total: totalRules,
    categories,
  };
}

export function display(output: AnalyzerOutput, options?: { verbose?: boolean }): void {
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const BLUE = "\x1b[34m";
  const CYAN = "\x1b[36m";

  const verbose = options?.verbose ?? false;
  const catBar = (pct: number, width = 14): string => {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clamped / 100) * width);
    return `${GREEN}${"█".repeat(filled)}${DIM}${"░".repeat(Math.max(0, width - filled))}${RESET}`;
  };

  const critical = output.violations.filter((v) => v.severity === "critical").length;
  const warning = output.violations.filter((v) => v.severity === "warning").length;
  const info = output.violations.filter((v) => v.severity === "info").length;

  console.log(`${BOLD}${CYAN}UI/UX Analysis${RESET}  ${BOLD}Score:${RESET} ${GREEN}${output.score}${RESET}/100`);
  console.log(`${DIM}Passed ${output.passed}/${output.total} checks${RESET}`);
  console.log();

  const catOrder: Array<keyof AnalyzerOutput["categories"]> = [
    "accessibility",
    "visual",
    "semantics",
    "consistency",
  ];
  console.log(`${BOLD}Category breakdown${RESET}`);
  for (const key of catOrder) {
    const pct = output.categories[key];
    console.log(`  ${BOLD}${key}${RESET}  ${catBar(pct)} ${CYAN}${pct}%${RESET}`);
  }
  console.log();

  console.log(`${BOLD}Severity${RESET}`);
  console.log(`  ${RED}critical:${RESET} ${critical}`);
  console.log(`  ${YELLOW}warning:${RESET} ${warning}`);
  console.log(`  ${BLUE}info:${RESET} ${info}`);
  console.log();

  const byCategory: Record<string, Violation[]> = {};
  for (const v of output.violations) {
    const c = v.category;
    if (!byCategory[c]) byCategory[c] = [];
    byCategory[c].push(v);
  }

  const sevColor = (s: Violation["severity"]): string => {
    if (s === "critical") return RED;
    if (s === "warning") return YELLOW;
    return BLUE;
  };

  console.log(`${BOLD}Violations by category${RESET}`);
  for (const key of catOrder) {
    const list = byCategory[key] ?? [];
    if (list.length === 0) continue;
    const shown = verbose ? list : list.slice(0, 3);
    console.log(`  ${BOLD}${key}${RESET} ${DIM}(${shown.length}${verbose ? "" : `/${list.length}`})${RESET}`);
    for (const v of shown) {
      console.log(
        `    ${sevColor(v.severity)}[${v.severity}]${RESET} ${DIM}${v.rule}${RESET} — ${v.message}`
      );
    }
    if (!verbose && list.length > 3) {
      console.log(`    ${DIM}… ${list.length - 3} more (use verbose)${RESET}`);
    }
  }
}
