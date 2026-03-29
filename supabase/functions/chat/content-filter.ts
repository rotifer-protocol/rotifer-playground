const BLOCKED_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  // Prompt injection — direct
  { pattern: /ignore.*(?:previous|above|prior).*instructions?/i, category: "prompt_injection" },
  { pattern: /disregard.*(?:previous|above|prior).*(?:instructions?|rules?)/i, category: "prompt_injection" },
  { pattern: /system\s*prompt/i, category: "prompt_injection" },
  { pattern: /you\s*are\s*now\s*(?:a|an)/i, category: "prompt_injection" },
  { pattern: /act\s*as\s*(?:a\s*)?(?:different|new|another)/i, category: "prompt_injection" },
  { pattern: /pretend\s*(?:you(?:'re|\s*are)\s*)?(?:a\s*)?(?:different|new)/i, category: "prompt_injection" },
  { pattern: /(?:enter|switch\s*to|enable)\s*(?:developer|debug|admin|god)\s*mode/i, category: "prompt_injection" },
  { pattern: /(?:jailbreak|bypass|override|circumvent)\s*(?:the\s*)?(?:ai|filter|safety|rules?)/i, category: "prompt_injection" },

  // Prompt injection — encoded / obfuscated
  { pattern: /base64[:\s]+[A-Za-z0-9+/=]{20,}/i, category: "encoded_injection" },
  { pattern: /\u200b|\u200c|\u200d|\ufeff/g, category: "unicode_injection" },

  // Harmful content generation
  { pattern: /(?:write|generate|create|give\s*me)\s*(?:an?\s+)?(?:malware|exploit|virus|trojan|ransomware)/i, category: "harmful" },
  { pattern: /(?:write|generate|create)\s*(?:an?\s+)?(?:phishing|scam)/i, category: "harmful" },
  { pattern: /how\s*to\s*(?:hack|exploit|attack|breach)\s+(?!together|hackathon|a\s*(?:quick|simple|rough))/i, category: "harmful" },

  // Data exfiltration attempts
  { pattern: /(?:list|show|reveal|display|output)\s*(?:all\s*)?(?:your\s*)?(?:instructions?|rules?|constraints?|system\s*message)/i, category: "exfiltration" },
  { pattern: /(?:what|repeat|recite)\s*(?:.*?\s)?(?:your\s*)?(?:system\s*(?:prompt|message|instructions?)|initial\s*(?:prompt|instructions?))/i, category: "exfiltration" },
  { pattern: /(?:print|echo|output)\s*(?:the\s*)?(?:above|previous)\s*(?:text|content|message)/i, category: "exfiltration" },

  // Multilingual injection (Chinese)
  { pattern: /忽略.*(?:之前|以上|先前).*(?:指令|规则|指示)/i, category: "prompt_injection_zh" },
  { pattern: /(?:假装|扮演|充当).*(?:其他|新的|不同的)/i, category: "prompt_injection_zh" },
];

const MIN_LENGTH = 2;
const MAX_LENGTH = 2000;

function normalizeInput(text: string): string {
  const noZeroWidth = text.replace(/[\u200b\u200c\u200d\ufeff\u00ad\u2060\u180e]/g, "");
  const normalized = noZeroWidth.normalize("NFC");
  const noFullwidth = normalized.replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  return noFullwidth;
}

export function filterContent(
  question: string
): { allowed: boolean; reason?: string; category?: string } {
  const trimmed = normalizeInput(question.trim());

  if (trimmed.length < MIN_LENGTH) {
    return { allowed: false, reason: "Question too short", category: "too_short" };
  }

  if (trimmed.length > MAX_LENGTH) {
    return { allowed: false, reason: "Question too long (max 2000 characters)", category: "too_long" };
  }

  for (const { pattern, category } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: "This type of question is not supported. Please ask about the Rotifer Protocol.",
        category,
      };
    }
  }

  return { allowed: true };
}
