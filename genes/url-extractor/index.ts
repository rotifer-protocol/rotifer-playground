interface ExtractorInput {
  text: string;
  includeEmails?: boolean;
  deduplicate?: boolean;
}

interface UrlEntry {
  url: string;
  protocol: string;
  domain: string;
  position: number;
}

interface ExtractorOutput {
  urls: UrlEntry[];
  emails: string[];
  totalFound: number;
  uniqueDomains: string[];
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]},;]+/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function extractDomain(url: string): string {
  try {
    const match = url.match(/^https?:\/\/([^/?#]+)/);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function extractProtocol(url: string): string {
  const match = url.match(/^(https?)/i);
  return match ? match[1].toLowerCase() : "";
}

function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?)]+$/, "");
}

export async function express(input: ExtractorInput): Promise<ExtractorOutput> {
  const text = input.text || "";
  const includeEmails = input.includeEmails ?? false;
  const deduplicate = input.deduplicate ?? true;

  const urlMatches: UrlEntry[] = [];
  const seen = new Set<string>();
  const re = new RegExp(URL_REGEX.source, URL_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const raw = cleanUrl(match[0]);
    if (deduplicate && seen.has(raw)) continue;
    seen.add(raw);
    urlMatches.push({
      url: raw,
      protocol: extractProtocol(raw),
      domain: extractDomain(raw),
      position: match.index,
    });
  }

  let emails: string[] = [];
  if (includeEmails) {
    const emailRe = new RegExp(EMAIL_REGEX.source, EMAIL_REGEX.flags);
    const emailSet = new Set<string>();
    let em: RegExpExecArray | null;
    while ((em = emailRe.exec(text)) !== null) {
      const addr = em[0].toLowerCase();
      if (!emailSet.has(addr)) {
        emailSet.add(addr);
        emails.push(addr);
      }
    }
  }

  const domainSet = new Set(urlMatches.map((u) => u.domain).filter((d) => d));

  return {
    urls: urlMatches,
    emails,
    totalFound: urlMatches.length,
    uniqueDomains: [...domainSet],
  };
}
