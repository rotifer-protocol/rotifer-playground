interface ContentInput {
  text: string;
  platform?: string;
  targetAudience?: string;
}

interface ViralityFactor {
  name: string;
  score: number;
  detail: string;
}

interface ContentOutput {
  readability: { score: number; grade: string; language: string };
  virality: { score: number; factors: ViralityFactor[] };
  sentiment: { tone: string; score: number };
  structure: {
    paragraphs: number;
    avgLength: number;
    hasHeadings: boolean;
    codeBlocks: number;
    links: number;
    wordCount: number;
  };
  recommendations: string[];
}

function detectLanguage(text: string): "Chinese" | "English" {
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const cjkMatches = text.match(cjkPattern) || [];
  const stripped = text.replace(/\s/g, "");
  const ratio = stripped.length > 0 ? cjkMatches.length / stripped.length : 0;
  return ratio > 0.3 ? "Chinese" : "English";
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 2) return 1;
  let count = 0;
  let prevVowel = false;
  for (let i = 0; i < w.length; i++) {
    const isVowel = "aeiou".includes(w[i]);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (w.endsWith("e") && count > 1) count--;
  return Math.max(count, 1);
}

function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function splitSentencesEnglish(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitSentencesChinese(text: string): string[] {
  return text
    .split(/[。！？!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function analyzeReadabilityEnglish(text: string): { score: number; grade: string } {
  const clean = stripCodeBlocks(text);
  const sentences = splitSentencesEnglish(clean);
  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (sentences.length === 0 || words.length === 0) {
    return { score: 100, grade: "Easy" };
  }

  let totalSyllables = 0;
  for (const w of words) totalSyllables += countSyllables(w);

  const gradeLevel =
    0.39 * (words.length / sentences.length) +
    11.8 * (totalSyllables / words.length) -
    15.59;

  const score = Math.max(0, Math.min(100, 100 - gradeLevel * 5));

  let grade: string;
  if (gradeLevel < 6) grade = "Easy";
  else if (gradeLevel <= 10) grade = "Standard";
  else if (gradeLevel <= 14) grade = "Advanced";
  else grade = "Academic";

  return { score: Math.round(score * 10) / 10, grade };
}

function analyzeReadabilityChinese(text: string): { score: number; grade: string } {
  const clean = stripCodeBlocks(text);
  const sentences = splitSentencesChinese(clean);
  if (sentences.length === 0) {
    return { score: 90, grade: "Easy" };
  }

  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  let totalChars = 0;
  for (const s of sentences) {
    const matches = s.match(cjkPattern) || [];
    totalChars += matches.length;
  }
  const avgCharsPerSentence = totalChars / sentences.length;

  let score: number;
  let grade: string;
  if (avgCharsPerSentence < 15) {
    score = 90;
    grade = "Easy";
  } else if (avgCharsPerSentence <= 25) {
    score = 70;
    grade = "Standard";
  } else if (avgCharsPerSentence <= 40) {
    score = 50;
    grade = "Advanced";
  } else {
    score = 30;
    grade = "Dense";
  }

  return { score, grade };
}

function scoreTitleAppeal(text: string, language: string): ViralityFactor {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) || "";
  const title = firstLine.replace(/^#+\s*/, "").trim();
  let score = 0;
  const details: string[] = [];

  if (/\d/.test(title)) {
    score += 5;
    details.push("contains number");
  }
  if (title.includes("?") || title.includes("？")) {
    score += 5;
    details.push("question format");
  }
  if (title.length >= 40 && title.length <= 70) {
    score += 5;
    details.push("optimal length");
  }
  if (language === "English" && /\b(How|Why|What)\b/i.test(title)) {
    score += 5;
    details.push("curiosity trigger");
  }
  if (language === "Chinese" && /如何|为什么|什么/.test(title)) {
    score += 5;
    details.push("curiosity trigger");
  }

  return {
    name: "Title Appeal",
    score,
    detail: details.length > 0 ? details.join(", ") : "no signals detected",
  };
}

function scoreEmotionalIntensity(text: string, language: string): ViralityFactor {
  const clean = stripCodeBlocks(text).toLowerCase();
  let score = 0;
  const details: string[] = [];

  const exclamations = (clean.match(/[!！]/g) || []).length;
  if (exclamations > 0) {
    score += Math.min(7, exclamations * 2);
    details.push(`${exclamations} exclamation(s)`);
  }

  const enPowerWords = [
    "amazing", "incredible", "breakthrough", "revolutionary", "powerful",
    "stunning", "remarkable", "extraordinary", "game-changing", "epic",
    "brilliant", "genius", "insane", "mind-blowing", "unbelievable",
  ];
  const zhPowerWords = [
    "革命", "突破", "颠覆", "震撼", "惊人", "卓越", "非凡", "史诗", "天才", "不可思议",
  ];
  const powerWords = language === "Chinese" ? zhPowerWords : enPowerWords;
  let powerCount = 0;
  for (const pw of powerWords) {
    if (clean.includes(pw)) powerCount++;
  }
  if (powerCount > 0) {
    score += Math.min(13, powerCount * 4);
    details.push(`${powerCount} power word(s)`);
  }

  return {
    name: "Emotional Intensity",
    score: Math.min(score, 20),
    detail: details.length > 0 ? details.join(", ") : "measured tone",
  };
}

function scorePracticalValue(text: string): ViralityFactor {
  let score = 0;
  const details: string[] = [];

  const codeBlocks = (text.match(/```/g) || []).length / 2;
  if (codeBlocks >= 1) {
    score += 7;
    details.push(`${Math.floor(codeBlocks)} code block(s)`);
  }

  if (/^[\s]*[-*]\s/m.test(text) || /^[\s]*\d+\.\s/m.test(text)) {
    score += 7;
    details.push("has lists");
  }

  if (/step\s*\d|第.步|步骤/i.test(text)) {
    score += 6;
    details.push("step-by-step format");
  }

  return {
    name: "Practical Value",
    score: Math.min(score, 20),
    detail: details.length > 0 ? details.join(", ") : "no actionable content detected",
  };
}

function scoreStoryElements(text: string, language: string): ViralityFactor {
  const clean = stripCodeBlocks(text).toLowerCase();
  let score = 0;
  const details: string[] = [];

  const enPronouns = /\b(i|we|my|our|me|us)\b/;
  const zhPronouns = /我|我们|咱们/;
  const pronounPattern = language === "Chinese" ? zhPronouns : enPronouns;
  if (pronounPattern.test(clean)) {
    score += 10;
    details.push("first-person narrative");
  }

  const narrativeSignals = language === "Chinese"
    ? /当时|后来|结果|终于|起初|最终|那天|突然/
    : /\b(when i|one day|turned out|finally|at first|suddenly|then i)\b/;
  if (narrativeSignals.test(clean)) {
    score += 10;
    details.push("narrative structure");
  }

  return {
    name: "Story Elements",
    score: Math.min(score, 20),
    detail: details.length > 0 ? details.join(", ") : "no narrative signals",
  };
}

function scoreSocialCurrency(text: string, language: string): ViralityFactor {
  const clean = stripCodeBlocks(text).toLowerCase();
  let score = 0;
  const details: string[] = [];

  const trendingTerms = [
    "ai", "llm", "gpt", "agent", "rust", "wasm", "web3", "blockchain",
    "kubernetes", "docker", "react", "nextjs", "typescript",
    "mcp", "rag", "fine-tuning", "transformer",
  ];
  let trendCount = 0;
  for (const term of trendingTerms) {
    if (clean.includes(term)) trendCount++;
  }
  if (trendCount > 0) {
    score += Math.min(10, trendCount * 3);
    details.push(`${trendCount} trending term(s)`);
  }

  const jargonPattern = language === "Chinese"
    ? /架构|框架|协议|范式|抽象|模块化|可扩展/
    : /\b(architecture|framework|protocol|paradigm|abstraction|modular|scalable)\b/;
  if (jargonPattern.test(clean)) {
    score += 10;
    details.push("technical depth");
  }

  return {
    name: "Social Currency",
    score: Math.min(score, 20),
    detail: details.length > 0 ? details.join(", ") : "general topic",
  };
}

function analyzeVirality(text: string, language: string): { score: number; factors: ViralityFactor[] } {
  const factors = [
    scoreTitleAppeal(text, language),
    scoreEmotionalIntensity(text, language),
    scorePracticalValue(text),
    scoreStoryElements(text, language),
    scoreSocialCurrency(text, language),
  ];
  const raw = factors.reduce((sum, f) => sum + f.score, 0);
  return { score: raw, factors };
}

function analyzeSentiment(text: string, language: string): { tone: string; score: number } {
  const clean = stripCodeBlocks(text).toLowerCase();

  const enPositive = [
    "great", "excellent", "love", "amazing", "powerful", "innovative", "breakthrough",
    "wonderful", "fantastic", "impressive", "elegant", "brilliant", "superb",
    "outstanding", "remarkable", "beautiful", "perfect", "awesome", "delightful",
    "exciting", "inspiring", "solid", "robust", "efficient", "seamless",
    "intuitive", "reliable", "fast", "clean", "simple",
  ];
  const enNegative = [
    "terrible", "awful", "broken", "fail", "crash", "bug", "problem", "error",
    "horrible", "worst", "ugly", "slow", "painful", "frustrating", "annoying",
    "confusing", "complicated", "bloated", "unreliable", "deprecated",
    "vulnerability", "exploit", "insecure", "leak", "deadlock",
    "bottleneck", "fragile", "hacky", "messy", "spaghetti",
  ];
  const zhPositive = [
    "好", "优秀", "强大", "创新", "突破", "出色", "卓越", "精彩",
    "高效", "优雅", "稳定", "流畅", "简洁", "可靠", "灵活",
    "先进", "完善", "成熟", "实用", "便捷",
  ];
  const zhNegative = [
    "差", "失败", "错误", "问题", "崩溃", "漏洞", "缺陷", "糟糕",
    "复杂", "混乱", "臃肿", "过时", "低效", "脆弱", "不稳定",
    "难用", "卡顿", "泄露", "死锁", "瓶颈",
  ];

  const positive = language === "Chinese" ? zhPositive : enPositive;
  const negative = language === "Chinese" ? zhNegative : enNegative;

  let posCount = 0;
  let negCount = 0;

  for (const w of positive) {
    const pattern = new RegExp(language === "Chinese" ? w : `\\b${w}\\b`, "g");
    const matches = clean.match(pattern);
    if (matches) posCount += matches.length;
  }
  for (const w of negative) {
    const pattern = new RegExp(language === "Chinese" ? w : `\\b${w}\\b`, "g");
    const matches = clean.match(pattern);
    if (matches) negCount += matches.length;
  }

  const total = posCount + negCount;
  const rawScore = total > 0 ? (posCount - negCount) / total : 0;
  const score = Math.round(rawScore * 100) / 100;

  let tone: string;
  if (score > 0.3) tone = "Positive";
  else if (score < -0.3) tone = "Negative";
  else tone = "Neutral";

  return { tone, score };
}

function analyzeStructure(
  text: string,
  language: string
): {
  paragraphs: number;
  avgLength: number;
  hasHeadings: boolean;
  codeBlocks: number;
  links: number;
  wordCount: number;
} {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const clean = stripCodeBlocks(text);
  const lines = clean.split("\n");
  const hasHeadings = lines.some((l) => /^#{1,6}\s/.test(l));

  const codeBlockMatches = text.match(/```/g) || [];
  const codeBlocks = Math.floor(codeBlockMatches.length / 2);

  const markdownLinks = (clean.match(/\[([^\]]*)\]\(([^)]*)\)/g) || []).length;
  const rawUrls = (clean.match(/https?:\/\/[^\s)>\]]+/g) || []).length;
  const links = markdownLinks + rawUrls - Math.min(markdownLinks, rawUrls);

  let wordCount: number;
  if (language === "Chinese") {
    const cjk = clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
    const enWords = clean.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, "").split(/\s+/).filter((w) => w.length > 0);
    wordCount = cjk.length + enWords.length;
  } else {
    wordCount = clean.split(/\s+/).filter((w) => w.length > 0).length;
  }

  const totalLength = paragraphs.reduce((sum, p) => sum + p.length, 0);
  const avgLength = paragraphs.length > 0 ? Math.round(totalLength / paragraphs.length) : 0;

  return {
    paragraphs: paragraphs.length,
    avgLength,
    hasHeadings,
    codeBlocks,
    links,
    wordCount,
  };
}

function generateRecommendations(
  readability: { score: number; grade: string },
  virality: { score: number },
  sentiment: { tone: string; score: number },
  structure: {
    paragraphs: number;
    avgLength: number;
    hasHeadings: boolean;
    codeBlocks: number;
    links: number;
    wordCount: number;
  },
  text: string,
  platform?: string
): string[] {
  const recs: string[] = [];

  if (readability.score < 50) {
    recs.push("Break long sentences into shorter ones for better readability");
  }
  if (!structure.hasHeadings) {
    recs.push("Add section headings for scannability");
  }
  if (structure.codeBlocks === 0 && platform === "dev.to") {
    recs.push("Add code examples for technical credibility");
  }
  if (virality.score < 40) {
    recs.push("Add a compelling hook in the first paragraph");
  }
  if (!/^[\s]*[-*]\s/m.test(text) && !/^[\s]*\d+\.\s/m.test(text)) {
    recs.push("Use bullet points or numbered lists for key takeaways");
  }
  if (sentiment.score < -0.3) {
    recs.push("Balance critique with constructive suggestions");
  }
  if (structure.wordCount < 300) {
    recs.push("Expand content — articles under 300 words rarely rank well");
  }
  if (structure.wordCount > 3000) {
    recs.push("Consider splitting into a series");
  }

  if (recs.length === 0) {
    recs.push("Content looks well-structured — consider A/B testing the title for higher engagement");
  }

  return recs;
}

export function express(input: ContentInput): ContentOutput {
  if (!input?.text || typeof input.text !== "string") {
    return {
      readability: { score: 0, grade: "N/A", language: "unknown" },
      virality: { score: 0, factors: [] },
      sentiment: { tone: "N/A", score: 0 },
      structure: { paragraphs: 0, avgLength: 0, hasHeadings: false, codeBlocks: 0, links: 0, wordCount: 0 },
      recommendations: ["No text content provided. Pass a text string via the 'text' field."],
    };
  }

  const { text, platform } = input;
  const language = detectLanguage(text);

  const readability = language === "Chinese"
    ? analyzeReadabilityChinese(text)
    : analyzeReadabilityEnglish(text);

  const virality = analyzeVirality(text, language);
  const sentiment = analyzeSentiment(text, language);
  const structure = analyzeStructure(text, language);
  const recommendations = generateRecommendations(
    readability, virality, sentiment, structure, text, platform
  );

  return {
    readability: { ...readability, language },
    virality,
    sentiment,
    structure,
    recommendations,
  };
}

export function display(output: ContentOutput, options?: { verbose?: boolean }): void {
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const BLUE = "\x1b[34m";
  const CYAN = "\x1b[36m";

  const verbose = options?.verbose ?? false;

  const readEmoji = (grade: string): string => {
    const g = grade.toLowerCase();
    if (g === "easy") return "🟢";
    if (g === "standard") return "🟡";
    if (g === "advanced" || g === "dense" || g === "academic") return "🟠";
    return "⚪";
  };

  const factorBar = (score: number, max = 20, width = 12): string => {
    const ratio = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
    const filled = Math.round(ratio * width);
    return `${GREEN}${"█".repeat(filled)}${DIM}${"░".repeat(Math.max(0, width - filled))}${RESET}`;
  };

  const sentimentStyle = (tone: string): string => {
    const t = tone.toLowerCase();
    if (t === "positive") return GREEN;
    if (t === "negative") return RED;
    return YELLOW;
  };

  console.log(`${BOLD}${CYAN}Content quality${RESET}`);
  console.log();
  console.log(`${BOLD}Scores${RESET}`);
  console.log(
    `  ${readEmoji(output.readability.grade)} ${BOLD}Readability${RESET}  ${GREEN}${output.readability.score}${RESET}/100  ${DIM}(${output.readability.grade} · ${output.readability.language})${RESET}`
  );
  console.log(
    `  📈 ${BOLD}Virality${RESET}     ${CYAN}${output.virality.score}${RESET}/100`
  );
  console.log(
    `  ${sentimentStyle(output.sentiment.tone)}💬${RESET} ${BOLD}Sentiment${RESET}  ${sentimentStyle(output.sentiment.tone)}${output.sentiment.tone}${RESET} ${DIM}(${output.sentiment.score >= 0 ? "+" : ""}${output.sentiment.score})${RESET}`
  );
  console.log();

  const factors = [...output.virality.factors].sort((a, b) => b.score - a.score);
  const factorsShown = verbose ? factors : factors.slice(0, 3);
  console.log(`${BOLD}Virality factors${RESET}`);
  for (const f of factorsShown) {
    console.log(`  ${BOLD}${f.name}${RESET}  ${factorBar(f.score)} ${CYAN}${f.score}${RESET}/20`);
    if (verbose) {
      console.log(`    ${DIM}${f.detail}${RESET}`);
    }
  }
  if (!verbose && factors.length > 3) {
    console.log(`  ${DIM}… ${factors.length - 3} more (use verbose)${RESET}`);
  }
  console.log();

  console.log(`${BOLD}Structure${RESET}`);
  console.log(
    `  ${DIM}Paragraphs${RESET} ${output.structure.paragraphs}  ${DIM}Avg len${RESET} ${output.structure.avgLength}  ${DIM}Words${RESET} ${output.structure.wordCount}`
  );
  console.log(
    `  ${DIM}Headings${RESET} ${output.structure.hasHeadings ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`}  ${DIM}Code blocks${RESET} ${output.structure.codeBlocks}  ${DIM}Links${RESET} ${output.structure.links}`
  );
  console.log();

  console.log(`${BOLD}Recommendations${RESET}`);
  for (const r of output.recommendations) {
    console.log(`  ${YELLOW}→${RESET} ${r}`);
  }
}
