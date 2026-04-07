interface GlossaryEntry {
  source: string;
  target: string;
}

interface TranslatorInput {
  text: string;
  sourceLang?: string;
  targetLang?: string;
  glossary?: GlossaryEntry[];
  formality?: "formal" | "neutral" | "informal";
}

interface TranslatorOutput {
  translation: string;
  alternatives: string[];
  confidence: number;
  detectedSourceLang?: string;
}

const BUILTIN_EN_ZH: Record<string, string> = {
  hello: "你好", world: "世界", code: "代码", gene: "基因",
  protocol: "协议", agent: "代理", function: "函数", data: "数据",
  file: "文件", search: "搜索", test: "测试", error: "错误",
  input: "输入", output: "输出", type: "类型", name: "名称",
  version: "版本", description: "描述", the: "", a: "", is: "是",
  are: "是", and: "和", or: "或", not: "不", this: "这",
  that: "那", it: "它", for: "为了", to: "到", of: "的",
  in: "在", on: "上", at: "在", by: "由", with: "用",
};

const BUILTIN_ZH_EN: Record<string, string> = {};
for (const [en, zh] of Object.entries(BUILTIN_EN_ZH)) {
  if (zh) BUILTIN_ZH_EN[zh] = en;
}

function detectLanguage(text: string): string {
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  const cjkMatches = text.match(cjkPattern) || [];
  const ratio = cjkMatches.length / Math.max(text.length, 1);
  return ratio > 0.3 ? "zh" : "en";
}

function applyGlossary(text: string, glossary: GlossaryEntry[]): { text: string; applied: number } {
  let result = text;
  let applied = 0;
  for (const entry of glossary) {
    const regex = new RegExp(escapeRegex(entry.source), "gi");
    if (regex.test(result)) {
      result = result.replace(regex, entry.target);
      applied++;
    }
  }
  return { text: result, applied };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translateWords(
  text: string,
  sourceLang: string,
  targetLang: string,
): { translation: string; matchedWords: number; totalWords: number } {
  const dict = sourceLang === "zh" ? BUILTIN_ZH_EN : BUILTIN_EN_ZH;

  if (sourceLang === "zh") {
    let result = text;
    let matched = 0;
    const chars = [...text].filter((c) => /[\u4e00-\u9fff]/.test(c));
    for (const char of new Set(chars)) {
      if (dict[char]) {
        result = result.replace(new RegExp(escapeRegex(char), "g"), dict[char]);
        matched++;
      }
    }
    return {
      translation: result,
      matchedWords: matched,
      totalWords: Math.max(new Set(chars).size, 1),
    };
  }

  const words = text.split(/\b/);
  let matched = 0;
  const contentWords = words.filter((w) => /[a-zA-Z]{2,}/.test(w));
  const translated = words.map((word) => {
    const lower = word.toLowerCase();
    if (dict[lower] !== undefined) {
      matched++;
      return dict[lower];
    }
    return word;
  });

  return {
    translation: translated.join(""),
    matchedWords: matched,
    totalWords: Math.max(contentWords.length, 1),
  };
}

export function express(input: TranslatorInput): TranslatorOutput {
  const sourceLang = input.sourceLang || detectLanguage(input.text);
  const targetLang = input.targetLang || (sourceLang === "zh" ? "en" : "zh");

  let workingText = input.text;
  let glossaryBoost = 0;

  if (input.glossary?.length) {
    const { text: glossaryApplied, applied } = applyGlossary(workingText, input.glossary);
    workingText = glossaryApplied;
    glossaryBoost = applied * 0.05;
  }

  const { translation, matchedWords, totalWords } = translateWords(
    workingText,
    sourceLang,
    targetLang,
  );

  const baseConfidence = matchedWords / totalWords;
  const confidence = Math.min(1, baseConfidence + glossaryBoost);

  return {
    translation,
    alternatives: [],
    confidence: Math.round(confidence * 100) / 100,
    detectedSourceLang: input.sourceLang ? undefined : sourceLang,
  };
}
