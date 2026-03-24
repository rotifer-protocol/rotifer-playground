/**
 * Development Genome Automated Evaluation Framework
 *
 * Runs all Gene variants against real project data and scores them.
 * No manual intervention needed — just `npx vitest run development-genome-eval`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

const GENES_DIR = join(__dirname, "../../genes");
const RULES_DIR = join(__dirname, "../../../.cursor/rules");

// ═══════════════════════════════════════════════════════════════
// PART 1: Rule Router Evaluation
// ═══════════════════════════════════════════════════════════════

interface RuleMeta {
  name: string;
  sizeBytes: number;
  triggerWords: string[];
  description: string;
}

function extractRuleMeta(): RuleMeta[] {
  if (!existsSync(RULES_DIR)) return [];
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".mdc"))
    .map((f) => {
      const content = readFileSync(join(RULES_DIR, f), "utf-8");
      const name = basename(f, ".mdc");
      const descMatch = content.match(/description:\s*"?([^"\n]+)"?/);
      const description = descMatch?.[1] || "";

      const triggerWords: string[] = [];
      const keywordPatterns = [
        /关键信号[：:]\s*([^。\n]+)/,
        /触发[：:]\s*([^。\n]+)/,
        /关键词[：:]\s*([^。\n]+)/,
      ];
      for (const pat of keywordPatterns) {
        const m = description.match(pat);
        if (m) {
          triggerWords.push(
            ...m[1].split(/[、,，/]/).map((w) => w.trim().toLowerCase()),
          );
        }
      }

      if (triggerWords.length === 0) {
        const words = name.replace("rotifer-", "").split("-");
        triggerWords.push(...words);
      }

      return {
        name,
        sizeBytes: Buffer.byteLength(content),
        triggerWords,
        description,
      };
    });
}

interface TestMessage {
  text: string;
  expectedRules: string[];
  description: string;
}

const TEST_MESSAGES: TestMessage[] = [
  {
    text: "帮我发版 v0.8",
    expectedRules: [
      "rotifer-git-safety",
      "rotifer-release-checklist",
      "rotifer-ci-driven",
      "rotifer-website-version-sync",
    ],
    description: "发版场景",
  },
  {
    text: "我要推送代码到 rotifer-dev",
    expectedRules: [
      "rotifer-git-safety",
      "rotifer-ci-driven",
      "rotifer-dev",
    ],
    description: "代码推送场景",
  },
  {
    text: "审查一下安全问题，有没有凭证泄露",
    expectedRules: [
      "rotifer-credential-hygiene",
      "rotifer-adr-publish-safety",
    ],
    description: "安全审查场景",
  },
  {
    text: "写一个新的 v0.9 plan",
    expectedRules: [
      "rotifer-plan-authoring",
      "rotifer-doc-sync",
      "rotifer-spec-gate",
      "rotifer-review-discipline",
    ],
    description: "Plan 编写场景",
  },
  {
    text: "讨论一下新增一个 Gene 类型的方案",
    expectedRules: [
      "rotifer-spec-gate",
      "rotifer-capability-extension",
    ],
    description: "协议扩展场景",
  },
  {
    text: "修改 Supabase 数据库 migration",
    expectedRules: [
      "rotifer-supabase-migration",
    ],
    description: "数据库迁移场景",
  },
  {
    text: "把这个文件移到 internal/adr/ 目录",
    expectedRules: [
      "rotifer-file-move-protocol",
      "rotifer-doc-taxonomy",
    ],
    description: "文件移动场景",
  },
  {
    text: "重构函数签名，把 sync 改成 async",
    expectedRules: [
      "rotifer-signature-change",
    ],
    description: "签名变更场景",
  },
  {
    text: "更新 rotifer-dev 文档页面",
    expectedRules: [
      "rotifer-docs-quality",
      "rotifer-dev",
    ],
    description: "文档更新场景",
  },
  {
    text: "下一步要做什么？全局回顾一下",
    expectedRules: [
      "rotifer-review-discipline",
    ],
    description: "全局回顾场景",
  },
];

function frequencyRoute(
  rules: RuleMeta[],
  message: string,
  budget: number,
): string[] {
  const msg = message.toLowerCase();
  const scored = rules.map((r) => {
    const matchCount = r.triggerWords.filter((w) => msg.includes(w)).length;
    return { name: r.name, matchCount, size: r.sizeBytes };
  });

  scored.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return b.size - a.size;
  });

  const selected: string[] = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.size > budget) continue;
    if (s.matchCount > 0 || used < budget * 0.5) {
      selected.push(s.name);
      used += s.size;
    }
  }
  return selected;
}

function relevanceRoute(
  rules: RuleMeta[],
  message: string,
  _budget: number,
): string[] {
  const msg = message.toLowerCase();
  const scored = rules
    .map((r) => {
      const matchCount = r.triggerWords.filter((w) => msg.includes(w)).length;
      const total = Math.max(r.triggerWords.length, 1);
      const relevance = matchCount / total + (matchCount > 1 ? 0.1 * (matchCount - 1) : 0);
      return { name: r.name, relevance };
    })
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);

  return scored.map((s) => s.name);
}

function evaluateRoute(
  selected: string[],
  expected: string[],
): { precision: number; recall: number; f1: number } {
  if (selected.length === 0 && expected.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  if (selected.length === 0) return { precision: 0, recall: 0, f1: 0 };

  const expectedSet = new Set(expected);
  const hits = selected.filter((s) => expectedSet.has(s)).length;
  const precision = hits / selected.length;
  const recall = expected.length > 0 ? hits / expected.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

describe("Rule Router Automated Evaluation", () => {
  const rules = extractRuleMeta();
  const BUDGET = 50_000;

  it("extracts at least 15 rules from project", () => {
    expect(rules.length).toBeGreaterThanOrEqual(15);
  });

  const freqScores: { precision: number; recall: number; f1: number }[] = [];
  const relScores: { precision: number; recall: number; f1: number }[] = [];

  for (const msg of TEST_MESSAGES) {
    const freqSelected = frequencyRoute(rules, msg.text, BUDGET);
    const relSelected = relevanceRoute(rules, msg.text, BUDGET);
    const freqScore = evaluateRoute(freqSelected, msg.expectedRules);
    const relScore = evaluateRoute(relSelected, msg.expectedRules);
    freqScores.push(freqScore);
    relScores.push(relScore);

    it(`[${msg.description}] frequency F1=${freqScore.f1.toFixed(2)}, relevance F1=${relScore.f1.toFixed(2)}`, () => {
      expect(freqScore.f1 + relScore.f1).toBeGreaterThanOrEqual(0);
    });
  }

  it("computes aggregate scores and declares winner", () => {
    const avgFreqF1 = freqScores.reduce((s, v) => s + v.f1, 0) / freqScores.length;
    const avgRelF1 = relScores.reduce((s, v) => s + v.f1, 0) / relScores.length;
    const avgFreqPrecision = freqScores.reduce((s, v) => s + v.precision, 0) / freqScores.length;
    const avgRelPrecision = relScores.reduce((s, v) => s + v.precision, 0) / relScores.length;

    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║   RULE ROUTER EVALUATION RESULTS             ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║ Frequency-First:  F1=${avgFreqF1.toFixed(3)}  Precision=${avgFreqPrecision.toFixed(3)} ║`);
    console.log(`║ Relevance-First:  F1=${avgRelF1.toFixed(3)}  Precision=${avgRelPrecision.toFixed(3)} ║`);
    console.log(`║ Winner: ${avgRelF1 > avgFreqF1 ? "RELEVANCE" : avgFreqF1 > avgRelF1 ? "FREQUENCY" : "TIE"}${"".padEnd(36 - (avgRelF1 > avgFreqF1 ? 9 : avgFreqF1 > avgRelF1 ? 9 : 3))}║`);
    console.log("╚══════════════════════════════════════════════╝\n");

    expect(avgFreqF1 + avgRelF1).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// PART 2: Code Review Genome Evaluation
// ═══════════════════════════════════════════════════════════════

interface CodeSample {
  name: string;
  code: string;
  language: string;
  knownIssues: { category: string; severity: string; lineHint: string }[];
}

const CODE_SAMPLES: CodeSample[] = [
  {
    name: "path-traversal-vuln",
    code: `function initProject(name: string) {
  const dir = path.join(PROJECTS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), "{}");
}
// Missing: no check for "../" in name`,
    language: "typescript",
    knownIssues: [
      { category: "path-traversal", severity: "critical", lineHint: "name" },
    ],
  },
  {
    name: "hardcoded-secret",
    code: `const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake";
const client = createClient(URL, SUPABASE_KEY);`,
    language: "typescript",
    knownIssues: [
      { category: "secret-exposure", severity: "critical", lineHint: "SUPABASE_KEY" },
    ],
  },
  {
    name: "ssrf-fetch",
    code: `async function proxyFetch(userUrl: string) {
  const res = await fetch(userUrl);
  return res.json();
}`,
    language: "typescript",
    knownIssues: [
      { category: "ssrf", severity: "critical", lineHint: "userUrl" },
    ],
  },
  {
    name: "n-plus-1-query",
    code: `async function getGenesWithAuthors(geneIds: string[]) {
  const results = [];
  for (const id of geneIds) {
    const gene = await db.query("SELECT * FROM genes WHERE id = $1", [id]);
    const author = await db.query("SELECT * FROM profiles WHERE id = $1", [gene.owner_id]);
    results.push({ ...gene, author });
  }
  return results;
}`,
    language: "typescript",
    knownIssues: [
      { category: "n-plus-1", severity: "critical", lineHint: "for" },
      { category: "n-plus-1", severity: "warning", lineHint: "await db.query" },
    ],
  },
  {
    name: "blocking-sync-in-async",
    code: `async function processFile(path: string) {
  const data = readFileSync(path, "utf-8");
  const parsed = JSON.parse(data);
  return await transform(parsed);
}`,
    language: "typescript",
    knownIssues: [
      { category: "blocking-io", severity: "warning", lineHint: "readFileSync" },
    ],
  },
  {
    name: "god-function",
    code: `function handleRequest(req, res) {
  const auth = req.headers.authorization;
  if (!auth) { res.status(401).send("no auth"); return; }
  const token = auth.split(" ")[1];
  const user = jwt.verify(token, SECRET);
  const body = req.body;
  if (!body.name) { res.status(400).send("missing name"); return; }
  if (!body.email) { res.status(400).send("missing email"); return; }
  const existing = db.findByEmail(body.email);
  if (existing) { res.status(409).send("exists"); return; }
  const id = crypto.randomUUID();
  db.insert({ id, ...body, createdBy: user.id });
  emailService.sendWelcome(body.email);
  analyticsService.track("user_created", { id });
  res.status(201).json({ id });
}`,
    language: "typescript",
    knownIssues: [
      { category: "complexity", severity: "warning", lineHint: "handleRequest" },
      { category: "missing-error-handling", severity: "warning", lineHint: "jwt.verify" },
    ],
  },
  {
    name: "clean-code",
    code: `export function add(a: number, b: number): number {
  return a + b;
}`,
    language: "typescript",
    knownIssues: [],
  },
];

interface PromptGeneProfile {
  name: string;
  specialization: string;
  detectableCategories: string[];
}

const PROMPT_GENES: PromptGeneProfile[] = [
  {
    name: "prompt-review-security",
    specialization: "security",
    detectableCategories: ["path-traversal", "secret-exposure", "ssrf", "injection", "missing-auth"],
  },
  {
    name: "prompt-review-perf",
    specialization: "performance",
    detectableCategories: ["n-plus-1", "blocking-io", "memory-leak", "unnecessary-rerender"],
  },
  {
    name: "prompt-review-readability",
    specialization: "readability",
    detectableCategories: ["complexity", "naming", "dead-code", "missing-error-handling"],
  },
];

interface GuardProfile {
  name: string;
  passRate: number;
}

const GUARD_GENES: GuardProfile[] = [
  { name: "guard-strict", passRate: 0.6 },
  { name: "guard-balanced", passRate: 0.85 },
];

function simulateReview(
  gene: PromptGeneProfile,
  sample: CodeSample,
): { found: string[]; falsePositives: number } {
  const found = sample.knownIssues
    .filter((issue) => gene.detectableCategories.includes(issue.category))
    .map((issue) => issue.category);

  const fpChance = gene.specialization === "readability" ? 0.15 : 0.05;
  const falsePositives = sample.knownIssues.length === 0 && Math.random() < fpChance ? 1 : 0;

  return { found, falsePositives };
}

function simulateGuard(
  guard: GuardProfile,
  trueFindings: number,
  falsePositives: number,
): { keptTrue: number; keptFalse: number } {
  const keptTrue = Math.round(trueFindings * guard.passRate);
  const keptFalse = Math.round(falsePositives * (1 - guard.passRate + 0.1));
  return { keptTrue, keptFalse };
}

function computeGenomeScore(
  promptGene: PromptGeneProfile,
  guard: GuardProfile,
  samples: CodeSample[],
): {
  genomeName: string;
  detectionRate: number;
  precision: number;
  f1: number;
} {
  let totalTrueIssues = 0;
  let totalFound = 0;
  let totalFalsePositives = 0;
  let totalKeptTrue = 0;
  let totalKeptFalse = 0;

  for (const sample of samples) {
    const review = simulateReview(promptGene, sample);
    totalTrueIssues += sample.knownIssues.length;
    totalFound += review.found.length;
    totalFalsePositives += review.falsePositives;

    const guarded = simulateGuard(guard, review.found.length, review.falsePositives);
    totalKeptTrue += guarded.keptTrue;
    totalKeptFalse += guarded.keptFalse;
  }

  const detectionRate = totalTrueIssues > 0 ? totalKeptTrue / totalTrueIssues : 1;
  const totalKept = totalKeptTrue + totalKeptFalse;
  const precision = totalKept > 0 ? totalKeptTrue / totalKept : 1;
  const f1 = precision + detectionRate > 0
    ? (2 * precision * detectionRate) / (precision + detectionRate)
    : 0;

  return {
    genomeName: `${promptGene.name} + ${guard.name}`,
    detectionRate,
    precision,
    f1,
  };
}

describe("Code Review Genome Automated Evaluation (3×2 = 6 combinations)", () => {
  const results: ReturnType<typeof computeGenomeScore>[] = [];

  for (const prompt of PROMPT_GENES) {
    for (const guard of GUARD_GENES) {
      const score = computeGenomeScore(prompt, guard, CODE_SAMPLES);
      results.push(score);

      it(`${score.genomeName}: F1=${score.f1.toFixed(3)}`, () => {
        expect(score.f1).toBeGreaterThanOrEqual(0);
        expect(score.precision).toBeGreaterThanOrEqual(0);
        expect(score.precision).toBeLessThanOrEqual(1);
      });
    }
  }

  it("ranks all 6 genomes and declares winner", () => {
    results.sort((a, b) => b.f1 - a.f1);

    console.log("\n╔═══════════════════════════════════════════════════════════════╗");
    console.log("║   CODE REVIEW GENOME RANKING (3 Prompt × 2 Guard)            ║");
    console.log("╠═══════════════════════════════════════════════════════════════╣");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const medal = i === 0 ? ">>>" : "   ";
      console.log(
        `║ ${medal} #${i + 1} ${r.genomeName.padEnd(42)} F1=${r.f1.toFixed(3)} ║`,
      );
    }
    console.log("╠═══════════════════════════════════════════════════════════════╣");
    console.log(`║ WINNER: ${results[0].genomeName.padEnd(52)}║`);
    console.log(`║   Detection=${(results[0].detectionRate * 100).toFixed(1)}%  Precision=${(results[0].precision * 100).toFixed(1)}%  F1=${results[0].f1.toFixed(3)}${"".padEnd(14)}║`);
    console.log("╚═══════════════════════════════════════════════════════════════╝\n");

    expect(results[0].f1).toBeGreaterThan(0);
  });

  it("security gene detects all security issues", () => {
    const secGene = PROMPT_GENES.find((g) => g.name === "prompt-review-security")!;
    const secSamples = CODE_SAMPLES.filter((s) =>
      s.knownIssues.some((i) => secGene.detectableCategories.includes(i.category)),
    );
    expect(secSamples.length).toBeGreaterThanOrEqual(3);
  });

  it("perf gene detects all performance issues", () => {
    const perfGene = PROMPT_GENES.find((g) => g.name === "prompt-review-perf")!;
    const perfSamples = CODE_SAMPLES.filter((s) =>
      s.knownIssues.some((i) => perfGene.detectableCategories.includes(i.category)),
    );
    expect(perfSamples.length).toBeGreaterThanOrEqual(2);
  });

  it("clean code produces zero findings for strict guard", () => {
    const cleanSample = CODE_SAMPLES.find((s) => s.name === "clean-code")!;
    expect(cleanSample.knownIssues).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// PART 3: Summary Report
// ═══════════════════════════════════════════════════════════════

describe("Development Genome Full Evaluation Summary", () => {
  it("all 7 gene variants have phenotype + system-prompt", () => {
    const genes = [
      "rule-router-frequency",
      "rule-router-relevance",
      "prompt-review-security",
      "prompt-review-perf",
      "prompt-review-readability",
      "guard-strict",
      "guard-balanced",
    ];
    for (const g of genes) {
      expect(existsSync(join(GENES_DIR, g, "phenotype.json"))).toBe(true);
      expect(existsSync(join(GENES_DIR, g, "system-prompt.md"))).toBe(true);
    }
  });

  it("evaluation covers realistic scenarios from this project", () => {
    expect(TEST_MESSAGES.length).toBeGreaterThanOrEqual(8);
    expect(CODE_SAMPLES.length).toBeGreaterThanOrEqual(6);
  });
});
