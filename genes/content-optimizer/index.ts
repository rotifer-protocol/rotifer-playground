interface ViralityFactor {
  name: string;
  score: number;
}

interface OptimizerInput {
  readability: { score: number; grade: string; language: string };
  virality: { score: number; factors?: ViralityFactor[] };
  sentiment: { tone: string; score: number };
  structure: {
    paragraphs: number;
    avgLength: number;
    hasHeadings: boolean;
    codeBlocks: number;
    links: number;
    wordCount: number;
  };
  recommendations?: string[];
}

interface OptimizerOutput {
  optimizedSuggestions: string[];
  priorityActions: string[];
  estimatedImpact: string;
}

interface ScoredSuggestion {
  text: string;
  impact: number;
}

function analyzeReadability(r: OptimizerInput["readability"]): ScoredSuggestion[] {
  const suggestions: ScoredSuggestion[] = [];
  const grade = r.grade.toLowerCase();

  if (grade === "academic" || grade === "dense") {
    suggestions.push({
      text: "Shorten sentences to improve readability — aim for 15-20 words per sentence on average",
      impact: 15,
    });
    suggestions.push({
      text: "Replace jargon with plain-language alternatives where possible",
      impact: 10,
    });
  }

  if (r.language.toLowerCase() === "english" && r.score < 50) {
    suggestions.push({
      text: "Simplify vocabulary — use common words to improve Flesch readability score above 50",
      impact: 20,
    });
  }

  if (r.score < 30) {
    suggestions.push({
      text: "Content is very difficult to read — consider rewriting key sections at a lower reading level",
      impact: 25,
    });
  } else if (r.score < 60) {
    suggestions.push({
      text: "Add transitional phrases between paragraphs to improve flow",
      impact: 8,
    });
  }

  if (grade === "simple" || grade === "easy") {
    suggestions.push({
      text: "Content may be too simplistic for a technical audience — add depth where appropriate",
      impact: 5,
    });
  }

  return suggestions;
}

function analyzeVirality(v: OptimizerInput["virality"]): ScoredSuggestion[] {
  const suggestions: ScoredSuggestion[] = [];

  if (v.factors) {
    const weak = v.factors.filter((f) => f.score < 10).sort((a, b) => a.score - b.score);

    const factorTips: Record<string, string> = {
      emotion: "Add emotionally resonant language — use storytelling or vivid examples",
      curiosity: "Open with a provocative question or surprising statistic to spark curiosity",
      practical: "Include actionable takeaways readers can apply immediately",
      novelty: "Highlight what makes this perspective unique or contrarian",
      social: "Add social proof — reference community adoption, user counts, or testimonials",
      shareability: "End with a quotable one-liner or tweetable summary",
      timeliness: "Connect to a current trend or recent event for topical relevance",
      controversy: "Present a balanced but bold stance to encourage discussion",
    };

    for (const factor of weak) {
      const key = factor.name.toLowerCase();
      const tip = factorTips[key];
      if (tip) {
        suggestions.push({ text: tip, impact: 12 });
      } else {
        suggestions.push({
          text: `Improve "${factor.name}" factor (currently ${factor.score}/100) — strengthen this dimension`,
          impact: 8,
        });
      }
    }
  }

  if (v.score < 30) {
    suggestions.push({
      text: "Overall virality is low — add a compelling hook in the first paragraph",
      impact: 15,
    });
  }

  return suggestions;
}

function analyzeSentiment(s: OptimizerInput["sentiment"]): ScoredSuggestion[] {
  const suggestions: ScoredSuggestion[] = [];
  const tone = s.tone.toLowerCase();

  if (tone === "negative" || s.score < -0.3) {
    suggestions.push({
      text: "Balance criticism with constructive solutions — readers engage more with problem+solution pairs",
      impact: 12,
    });
  }

  if (tone === "neutral" || (s.score > -0.1 && s.score < 0.1)) {
    suggestions.push({
      text: "Add personal anecdotes or opinions to make the tone more engaging",
      impact: 10,
    });
    suggestions.push({
      text: "Use active voice and direct address ('you') to create connection with the reader",
      impact: 7,
    });
  }

  if (tone === "very negative" || s.score < -0.6) {
    suggestions.push({
      text: "Tone is strongly negative — consider reframing to focus on opportunities rather than problems",
      impact: 15,
    });
  }

  return suggestions;
}

function analyzeStructure(st: OptimizerInput["structure"]): ScoredSuggestion[] {
  const suggestions: ScoredSuggestion[] = [];

  if (!st.hasHeadings) {
    suggestions.push({
      text: "Add H2/H3 section headings to improve scannability and SEO",
      impact: 18,
    });
  }

  if (st.codeBlocks === 0) {
    suggestions.push({
      text: "Include code examples to make technical content more concrete and actionable",
      impact: 12,
    });
  }

  if (st.avgLength > 200) {
    suggestions.push({
      text: "Break long paragraphs (avg >200 words) into smaller chunks of 80-150 words",
      impact: 14,
    });
  }

  if (st.links === 0) {
    suggestions.push({
      text: "Add relevant external links or references to build credibility",
      impact: 8,
    });
  }

  if (st.wordCount < 300) {
    suggestions.push({
      text: "Content is very short (<300 words) — expand with examples or deeper analysis for better engagement",
      impact: 10,
    });
  } else if (st.wordCount > 3000) {
    suggestions.push({
      text: "Content is lengthy (>3000 words) — consider adding a TL;DR summary at the top",
      impact: 6,
    });
  }

  if (st.paragraphs < 3 && st.wordCount > 500) {
    suggestions.push({
      text: "Too few paragraphs for the word count — break content into more digestible sections",
      impact: 10,
    });
  }

  return suggestions;
}

function estimateImpact(
  readability: number,
  virality: number,
  sentimentScore: number,
  suggestionCount: number
): string {
  const avgScore = (readability + virality) / 2;

  if (avgScore < 40 && suggestionCount > 5) {
    return "High (+20-30 points potential improvement across dimensions)";
  }
  if (avgScore < 65 && suggestionCount > 3) {
    return "Moderate (+10-20 points potential improvement across dimensions)";
  }
  return "Low (+5-10 points — content is already in good shape)";
}

export function express(input: OptimizerInput): OptimizerOutput {
  if (!input?.readability || !input?.structure) {
    return {
      optimizedSuggestions: ["No content analysis data provided. Ensure upstream content-quality-analyzer completed successfully."],
      priorityActions: [],
      estimatedImpact: "N/A",
    };
  }

  const allSuggestions: ScoredSuggestion[] = [
    ...analyzeReadability(input.readability),
    ...analyzeVirality(input.virality ?? { score: 0 }),
    ...analyzeSentiment(input.sentiment ?? { tone: "Neutral", score: 0 }),
    ...analyzeStructure(input.structure),
  ];

  if (input.recommendations) {
    for (const rec of input.recommendations) {
      allSuggestions.push({ text: rec, impact: 5 });
    }
  }

  allSuggestions.sort((a, b) => b.impact - a.impact);

  const optimizedSuggestions = allSuggestions.map((s) => s.text);
  const priorityActions = allSuggestions.slice(0, 3).map((s) => s.text);

  const impact = estimateImpact(
    input.readability.score,
    input.virality.score,
    input.sentiment.score,
    allSuggestions.length
  );

  return {
    optimizedSuggestions,
    priorityActions,
    estimatedImpact: impact,
  };
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

export function display(output: OptimizerOutput, options?: { verbose?: boolean }): void {
  console.log(`${BOLD}${CYAN}Content Optimization${RESET}`);
  console.log(`${DIM}${"─".repeat(40)}${RESET}`);
  console.log(`${BOLD}Priority actions${RESET}`);
  output.priorityActions.forEach((action, i) => {
    console.log(`  ${GREEN}➜${RESET} ${BOLD}${i + 1}.${RESET} ${action}`);
  });
  if (options?.verbose && output.optimizedSuggestions.length > 0) {
    console.log("");
    console.log(`${BOLD}All suggestions${RESET}`);
    output.optimizedSuggestions.forEach((s, i) => {
      console.log(`  ${BLUE}${i + 1}.${RESET} ${s}`);
    });
  }
  console.log("");
  console.log(`${DIM}Estimated impact:${RESET} ${YELLOW}${output.estimatedImpact}${RESET}`);
}
