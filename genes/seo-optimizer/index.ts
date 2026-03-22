interface SEOInput {
  content: string;
  targetKeyword?: string;
  url?: string;
}

interface SEOIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  suggestion: string;
}

interface SEOOutput {
  score: number;
  issues: SEOIssue[];
  keywordDensity: number;
  wordCount: number;
  headingStructure: {
    h1Count: number;
    h2Count: number;
    h3Count: number;
    hasProperHierarchy: boolean;
  };
  metaAnalysis: {
    titleLength: number;
    hasMetaDescription: boolean;
    descriptionLength: number;
  };
  readabilityScore: number;
}

function countOccurrences(text: string, keyword: string): number {
  if (!keyword) return 0;
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(kw, pos)) !== -1) {
    count++;
    pos += kw.length;
  }
  return count;
}

function extractHeadings(content: string): { h1: string[]; h2: string[]; h3: string[] } {
  const h1 = [...content.matchAll(/<h1[^>]*>(.*?)<\/h1>/gi)].map((m) => m[1]);
  const h2 = [...content.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map((m) => m[1]);
  const h3 = [...content.matchAll(/<h3[^>]*>(.*?)<\/h3>/gi)].map((m) => m[1]);

  const mdH1 = [...content.matchAll(/^#\s+(.+)$/gm)].map((m) => m[1]);
  const mdH2 = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
  const mdH3 = [...content.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]);

  return {
    h1: [...h1, ...mdH1],
    h2: [...h2, ...mdH2],
    h3: [...h3, ...mdH3],
  };
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function extractMeta(content: string): { title: string; description: string } {
  const titleMatch = content.match(/<title[^>]*>(.*?)<\/title>/i);
  const descMatch = content.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i);
  return {
    title: titleMatch ? titleMatch[1] : "",
    description: descMatch ? descMatch[1] : "",
  };
}

function fleschKincaid(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (words.length === 0 || sentences.length === 0) return 0;

  let totalSyllables = 0;
  for (const word of words) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, "");
    const vowelGroups = clean.match(/[aeiouy]+/g);
    totalSyllables += vowelGroups ? Math.max(vowelGroups.length, 1) : 1;
  }

  return Math.max(
    0,
    Math.min(100, 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (totalSyllables / words.length))
  );
}

/**
 * SEO Optimizer Gene
 *
 * Analyzes content for search engine optimization metrics.
 * Checks keyword density, heading structure, meta tags, and readability.
 */
export async function express(input: SEOInput): Promise<SEOOutput> {
  const content = (input.content || "").trim();
  const keyword = (input.targetKeyword || "").trim();
  const issues: SEOIssue[] = [];

  if (!content) {
    return {
      score: 0,
      issues: [{ severity: "error", rule: "no-content", message: "No content provided", suggestion: "Provide text or HTML content to analyze" }],
      keywordDensity: 0,
      wordCount: 0,
      headingStructure: { h1Count: 0, h2Count: 0, h3Count: 0, hasProperHierarchy: false },
      metaAnalysis: { titleLength: 0, hasMetaDescription: false, descriptionLength: 0 },
      readabilityScore: 0,
    };
  }

  const plainText = stripHTML(content);
  const words = plainText.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;

  // Word count analysis
  if (wordCount < 300) {
    issues.push({ severity: "warning", rule: "thin-content", message: `Content has only ${wordCount} words`, suggestion: "Aim for at least 300 words for better SEO" });
  } else if (wordCount >= 1000) {
    issues.push({ severity: "info", rule: "long-content", message: `Good content length: ${wordCount} words`, suggestion: "Long-form content tends to rank better" });
  }

  // Keyword analysis
  let keywordDensity = 0;
  if (keyword) {
    const kwCount = countOccurrences(plainText, keyword);
    keywordDensity = wordCount > 0 ? (kwCount / wordCount) * 100 : 0;

    if (kwCount === 0) {
      issues.push({ severity: "error", rule: "keyword-missing", message: `Target keyword "${keyword}" not found in content`, suggestion: "Include the target keyword naturally in your content" });
    } else if (keywordDensity > 3) {
      issues.push({ severity: "warning", rule: "keyword-stuffing", message: `Keyword density is ${keywordDensity.toFixed(1)}% (too high)`, suggestion: "Keep keyword density between 1-3% to avoid over-optimization" });
    } else if (keywordDensity < 0.5) {
      issues.push({ severity: "warning", rule: "keyword-low", message: `Keyword density is ${keywordDensity.toFixed(1)}% (too low)`, suggestion: "Include the keyword a few more times naturally" });
    }
  }

  // Heading structure
  const headings = extractHeadings(content);
  const h1Count = headings.h1.length;
  const h2Count = headings.h2.length;
  const h3Count = headings.h3.length;

  if (h1Count === 0) {
    issues.push({ severity: "error", rule: "missing-h1", message: "No H1 heading found", suggestion: "Add exactly one H1 heading as the main title" });
  } else if (h1Count > 1) {
    issues.push({ severity: "warning", rule: "multiple-h1", message: `Found ${h1Count} H1 headings`, suggestion: "Use only one H1 heading per page" });
  }

  if (h2Count === 0 && wordCount > 300) {
    issues.push({ severity: "warning", rule: "missing-h2", message: "No H2 headings found", suggestion: "Break content into sections with H2 headings" });
  }

  const hasProperHierarchy = h1Count === 1 && (h2Count > 0 || wordCount < 300);

  if (keyword && h1Count > 0) {
    const h1HasKeyword = headings.h1.some((h) => h.toLowerCase().includes(keyword.toLowerCase()));
    if (!h1HasKeyword) {
      issues.push({ severity: "warning", rule: "keyword-not-in-h1", message: "Target keyword not found in H1", suggestion: "Include the target keyword in your main heading" });
    }
  }

  // Meta analysis
  const meta = extractMeta(content);
  const titleLength = meta.title.length;
  const hasMetaDescription = meta.description.length > 0;
  const descriptionLength = meta.description.length;

  if (titleLength > 0 && titleLength < 30) {
    issues.push({ severity: "warning", rule: "title-short", message: `Title is too short (${titleLength} chars)`, suggestion: "Aim for 50-60 characters in the title" });
  } else if (titleLength > 60) {
    issues.push({ severity: "warning", rule: "title-long", message: `Title is too long (${titleLength} chars)`, suggestion: "Keep title under 60 characters to prevent truncation in search results" });
  }

  if (hasMetaDescription && descriptionLength < 120) {
    issues.push({ severity: "warning", rule: "description-short", message: `Meta description is short (${descriptionLength} chars)`, suggestion: "Aim for 150-160 characters" });
  } else if (hasMetaDescription && descriptionLength > 160) {
    issues.push({ severity: "warning", rule: "description-long", message: `Meta description is long (${descriptionLength} chars)`, suggestion: "Keep meta description under 160 characters" });
  }

  // Readability
  const readabilityScore = Math.round(fleschKincaid(plainText) * 100) / 100;

  if (readabilityScore < 30) {
    issues.push({ severity: "warning", rule: "readability-low", message: `Readability score is low (${readabilityScore})`, suggestion: "Simplify sentences and use common words for better accessibility" });
  }

  // Score calculation
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - errorCount * 15 - warningCount * 5));

  return {
    score,
    issues,
    keywordDensity: Math.round(keywordDensity * 100) / 100,
    wordCount,
    headingStructure: { h1Count, h2Count, h3Count, hasProperHierarchy },
    metaAnalysis: { titleLength, hasMetaDescription, descriptionLength },
    readabilityScore,
  };
}
