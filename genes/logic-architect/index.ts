export function express(input: { code: string; language?: string }) {
  const code = input.code || "";
  const lang = input.language || detectLanguage(code);
  const lines = code.split("\n");

  const imports = parseImports(lines, lang);
  const exports = parseExports(lines, lang);
  const uniqueModules = new Set(imports.map((i) => i.module));
  const dependencyCount = uniqueModules.size;
  const relativeCount = imports.filter((i) => i.isRelative).length;
  const relativeRatio = imports.length > 0 ? relativeCount / imports.length : 0;
  const couplingLevel = classifyCoupling(dependencyCount, relativeRatio);
  const issues = detectIssues(imports, lines, lang);
  const suggestions = generateSuggestions(couplingLevel, imports, issues);

  return { imports, exports, dependencyCount, couplingLevel, issues, suggestions };
}

function detectLanguage(code: string): string {
  if (/^use\s+\w+|^mod\s+\w+|^fn\s+\w+|->/.test(code)) return "rust";
  if (/^package\s+\w+|^import\s*\(/.test(code)) return "go";
  if (/^(from\s+\S+\s+import|import\s+\w+)/.test(code) && !/[{};]/.test(code)) return "python";
  if (/:\s*\w+[\s;]|interface\s|type\s+\w+\s*=/.test(code)) return "typescript";
  return "javascript";
}

function parseImports(lines: string[], lang: string) {
  const imports: { module: string; members: string[]; isRelative: boolean }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    if (lang === "typescript" || lang === "javascript") {
      const esm = trimmed.match(/import\s+(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (esm) {
        const members = esm[1] ? esm[1].split(",").map((m) => m.trim().split(/\s+as\s+/)[0]).filter(Boolean)
          : esm[2] ? [esm[2]] : esm[3] ? ["* as " + esm[3]] : [];
        imports.push({ module: esm[4], members, isRelative: esm[4].startsWith(".") });
        continue;
      }
      const cjs = trimmed.match(/(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (cjs) {
        const members = cjs[1] ? cjs[1].split(",").map((m) => m.trim()).filter(Boolean) : cjs[2] ? [cjs[2]] : [];
        imports.push({ module: cjs[3], members, isRelative: cjs[3].startsWith(".") });
        continue;
      }
      const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
      if (sideEffect) {
        imports.push({ module: sideEffect[1], members: [], isRelative: sideEffect[1].startsWith(".") });
        continue;
      }
    }

    if (lang === "python") {
      const fromImport = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)/);
      if (fromImport) {
        const members = fromImport[2].split(",").map((m) => m.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        imports.push({ module: fromImport[1], members, isRelative: fromImport[1].startsWith(".") });
        continue;
      }
      const plain = trimmed.match(/^import\s+(.+)/);
      if (plain) {
        for (const mod of plain[1].split(",")) {
          const name = mod.trim().split(/\s+as\s+/)[0];
          if (name) imports.push({ module: name, members: [], isRelative: false });
        }
        continue;
      }
    }

    if (lang === "rust") {
      const useStmt = trimmed.match(/^use\s+([^;]+)/);
      if (useStmt) {
        const path = useStmt[1].replace(/\s+/g, "");
        const isRelative = path.startsWith("crate::") || path.startsWith("super::") || path.startsWith("self::");
        imports.push({ module: path, members: [], isRelative });
        continue;
      }
    }

    if (lang === "go") {
      const goImport = trimmed.match(/^import\s+(?:\w+\s+)?["']([^"']+)["']/);
      if (goImport) {
        imports.push({ module: goImport[1], members: [], isRelative: goImport[1].startsWith(".") || goImport[1].startsWith("/") });
      }
    }
  }
  return imports;
}

function parseExports(lines: string[], lang: string): string[] {
  const exports: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (lang === "typescript" || lang === "javascript") {
      const named = t.match(/^export\s+(?:const|let|var|function|class|type|interface|enum|async\s+function)\s+(\w+)/);
      if (named) { exports.push(named[1]); continue; }
      if (t.startsWith("export default")) { exports.push("default"); continue; }
      const reExport = t.match(/^export\s+\{([^}]+)\}/);
      if (reExport) { exports.push(...reExport[1].split(",").map((m) => m.trim().split(/\s+as\s+/).pop()!).filter(Boolean)); }
    }
    if (lang === "python") {
      const allExport = t.match(/^__all__\s*=\s*\[([^\]]*)\]/);
      if (allExport) exports.push(...allExport[1].replace(/['"]/g, "").split(",").map((m) => m.trim()).filter(Boolean));
    }
    if (lang === "rust" && t.startsWith("pub ")) {
      const pubItem = t.match(/^pub\s+(?:fn|struct|enum|trait|type|mod|const|static)\s+(\w+)/);
      if (pubItem) exports.push(pubItem[1]);
    }
  }
  return exports;
}

function classifyCoupling(depCount: number, relRatio: number): string {
  const score = depCount + (relRatio > 0.6 ? 3 : relRatio > 0.3 ? 1 : 0);
  if (score <= 3) return "low";
  if (score <= 7) return "moderate";
  if (score <= 12) return "high";
  return "very-high";
}

function detectIssues(imports: { module: string; members: string[]; isRelative: boolean }[], lines: string[], lang: string): string[] {
  const issues: string[] = [];
  for (const imp of imports) {
    if (imp.module.includes("../../../")) issues.push(`Deep relative path: ${imp.module}`);
    if (imp.members.some((m) => m.startsWith("*"))) issues.push(`Wildcard import from ${imp.module}`);
  }
  const modules = imports.map((i) => i.module);
  const seen = new Set<string>();
  for (const m of modules) { if (seen.has(m)) issues.push(`Duplicate import: ${m}`); seen.add(m); }
  if (lang === "typescript" || lang === "javascript") {
    for (const line of lines) {
      if (/require\(.*\+.*\)/.test(line)) issues.push("Dynamic require with concatenation detected");
    }
  }
  return issues;
}

function generateSuggestions(coupling: string, imports: { module: string; isRelative: boolean }[], issues: string[]): string[] {
  const suggestions: string[] = [];
  if (coupling === "high" || coupling === "very-high")
    suggestions.push("Consider splitting this module — high dependency count indicates too many responsibilities");
  if (imports.filter((i) => i.isRelative).length > 5)
    suggestions.push("Many relative imports suggest tight coupling — consider using path aliases or barrel exports");
  if (issues.some((i) => i.includes("Deep relative")))
    suggestions.push("Replace deep relative paths (../../..) with absolute imports or path aliases");
  if (issues.some((i) => i.includes("Wildcard")))
    suggestions.push("Replace wildcard imports with named imports for better tree-shaking");
  if (imports.length === 0)
    suggestions.push("No imports detected — verify the module has proper dependency declarations");
  return suggestions;
}
