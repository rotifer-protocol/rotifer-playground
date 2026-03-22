interface ReadabilityInput {
  text: string;
}

interface ReadabilityOutput {
  fleschKincaid: number;
  gradeLevel: number;
  avgSentenceLength: number;
  avgSyllablesPerWord: number;
  wordCount: number;
  sentenceCount: number;
  complexWordRatio: number;
  verdict: string;
}

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 2) return 1;

  const vowelGroups = word.match(/[aeiouy]+/g);
  let count = vowelGroups ? vowelGroups.length : 1;

  if (word.endsWith("e") && !word.endsWith("le") && count > 1) count--;
  if (word.endsWith("ed") && count > 1) count--;
  if (word.endsWith("es") && !word.endsWith("ses") && !word.endsWith("zes") && count > 1) count--;

  return Math.max(count, 1);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z'-]/g, ""))
    .filter((w) => w.length > 0);
}

function getVerdict(score: number): string {
  if (score >= 90) return "Very easy to read (5th grade)";
  if (score >= 80) return "Easy to read (6th grade)";
  if (score >= 70) return "Fairly easy to read (7th grade)";
  if (score >= 60) return "Standard (8th-9th grade)";
  if (score >= 50) return "Fairly difficult (10th-12th grade)";
  if (score >= 30) return "Difficult (college level)";
  return "Very difficult (graduate level)";
}

/**
 * Readability Analyzer Gene
 *
 * Computes Flesch-Kincaid readability metrics for English text.
 * Pure algorithmic implementation with no external dependencies.
 */
export async function express(input: ReadabilityInput): Promise<ReadabilityOutput> {
  const text = (input.text || "").trim();
  if (!text) {
    return {
      fleschKincaid: 0,
      gradeLevel: 0,
      avgSentenceLength: 0,
      avgSyllablesPerWord: 0,
      wordCount: 0,
      sentenceCount: 0,
      complexWordRatio: 0,
      verdict: "No text provided",
    };
  }

  const sentences = splitSentences(text);
  const words = splitWords(text);
  const sentenceCount = Math.max(sentences.length, 1);
  const wordCount = words.length;

  if (wordCount === 0) {
    return {
      fleschKincaid: 0,
      gradeLevel: 0,
      avgSentenceLength: 0,
      avgSyllablesPerWord: 0,
      wordCount: 0,
      sentenceCount: 0,
      complexWordRatio: 0,
      verdict: "No words found",
    };
  }

  const syllableCounts = words.map(countSyllables);
  const totalSyllables = syllableCounts.reduce((a, b) => a + b, 0);
  const complexWords = syllableCounts.filter((s) => s >= 3).length;

  const avgSentenceLength = wordCount / sentenceCount;
  const avgSyllablesPerWord = totalSyllables / wordCount;
  const complexWordRatio = complexWords / wordCount;

  // Flesch-Kincaid Reading Ease: 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)
  const fleschKincaid = Math.max(
    0,
    Math.min(100, 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord)
  );

  // Flesch-Kincaid Grade Level: 0.39*(words/sentences) + 11.8*(syllables/words) - 15.59
  const gradeLevel = Math.max(
    0,
    0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59
  );

  return {
    fleschKincaid: Math.round(fleschKincaid * 100) / 100,
    gradeLevel: Math.round(gradeLevel * 10) / 10,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    avgSyllablesPerWord: Math.round(avgSyllablesPerWord * 100) / 100,
    wordCount,
    sentenceCount,
    complexWordRatio: Math.round(complexWordRatio * 1000) / 1000,
    verdict: getVerdict(fleschKincaid),
  };
}
