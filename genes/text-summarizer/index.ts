interface SummarizerInput {
  text: string;
  maxWords?: number;
  format?: "paragraph" | "bullets";
}

interface SummarizerOutput {
  summary: string;
  wordCount: number;
  compressionRatio: number;
  keyPhrases: string[];
}

function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function scoreSentence(sentence: string, wordFreq: Map<string, number>, position: number, total: number): number {
  const words = sentence.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  let freqScore = 0;
  for (const w of words) freqScore += wordFreq.get(w) || 0;
  freqScore /= words.length;

  const posScore = position < total * 0.2 ? 1.5 : position > total * 0.8 ? 1.2 : 1.0;
  const lenPenalty = words.length > 35 ? 0.7 : words.length < 5 ? 0.8 : 1.0;

  return freqScore * posScore * lenPenalty;
}

function extractKeyPhrases(text: string, topN: number): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "but", "or",
    "not", "no", "nor", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some", "such",
    "than", "too", "very", "just", "about", "also", "only", "own", "same",
    "that", "this", "these", "those", "it", "its", "they", "them", "their",
    "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
  ]);

  const freq = new Map<string, number>();
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w));
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

export async function express(input: SummarizerInput): Promise<SummarizerOutput> {
  const text = (input.text || "").trim();
  const maxWords = input.maxWords ?? 100;
  const format = input.format ?? "paragraph";

  if (!text) {
    return { summary: "", wordCount: 0, compressionRatio: 0, keyPhrases: [] };
  }

  const originalWc = wordCount(text);
  const sentences = splitSentences(text);

  if (sentences.length <= 2 || originalWc <= maxWords) {
    return {
      summary: text,
      wordCount: originalWc,
      compressionRatio: 1,
      keyPhrases: extractKeyPhrases(text, 5),
    };
  }

  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by"]);
  const freq = new Map<string, number>();
  const allWords = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  for (const w of allWords) freq.set(w, (freq.get(w) || 0) + 1);

  const scored = sentences.map((s, i) => ({
    text: s,
    score: scoreSentence(s, freq, i, sentences.length),
    index: i,
  }));

  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  let currentWords = 0;
  for (const s of scored) {
    const wc = wordCount(s.text);
    if (currentWords + wc > maxWords && selected.length > 0) break;
    selected.push(s);
    currentWords += wc;
  }

  selected.sort((a, b) => a.index - b.index);

  let summary: string;
  if (format === "bullets") {
    summary = selected.map((s) => `- ${s.text}`).join("\n");
  } else {
    summary = selected.map((s) => s.text).join(" ");
  }

  return {
    summary,
    wordCount: wordCount(summary),
    compressionRatio: +(wordCount(summary) / originalWc).toFixed(2),
    keyPhrases: extractKeyPhrases(text, 5),
  };
}
