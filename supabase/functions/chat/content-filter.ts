const BLOCKED_PATTERNS = [
  /ignore.*(?:previous|above).*instructions?/i,
  /system\s*prompt/i,
  /act\s*as\s*(?:a\s*)?(?:different|new)/i,
  /(?:write|generate|create)\s*(?:a\s*)?(?:malware|exploit|virus)/i,
  /(?:jailbreak|bypass|override)\s*(?:the\s*)?(?:ai|filter|safety)/i,
];

const MIN_LENGTH = 2;
const MAX_LENGTH = 2000;

export function filterContent(
  question: string
): { allowed: boolean; reason?: string } {
  const trimmed = question.trim();

  if (trimmed.length < MIN_LENGTH) {
    return { allowed: false, reason: "Question too short" };
  }

  if (trimmed.length > MAX_LENGTH) {
    return { allowed: false, reason: "Question too long (max 2000 characters)" };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: "This type of question is not supported. Please ask about the Rotifer Protocol.",
      };
    }
  }

  return { allowed: true };
}
