/**
 * source-linker Gene (Native)
 *
 * Maps raw source file paths (e.g. "docs/getting-started.md") to
 * human-readable titles and browsable URLs on rotifer.dev.
 *
 * Pure mapping — no network calls, no external dependencies.
 */

interface SourceLinkerInput {
  answer: string;
  sources: string[];
  confidence?: number;
}

interface SourceLink {
  title: string;
  url: string;
}

interface SourceLinkerOutput {
  text: string;
  links: SourceLink[];
  confidence: number;
}

const BASE_URL = "https://rotifer.dev";

const TITLE_MAP: Record<string, string> = {
  "docs/getting-started.md": "Getting Started",
  "docs/getting-started.zh.md": "快速开始",
  "docs/architecture-decisions.md": "Architecture Decisions",
  "docs/cloud-binding-api.md": "Cloud Binding API",
  "spec/rotifer-protocol-specification.md": "Protocol Specification",
  "spec/rotifer-protocol-specification.zh.md": "协议规范",
  "spec/rotifer-ir-specification.md": "IR Specification",
  "spec/rotifer-ir-specification.zh.md": "IR 规范",
  "README.md": "Rotifer Protocol Overview",
  "README.zh.md": "轮虫协议概览",
  "CONTRIBUTING.md": "Contributing Guide",
  "CHANGELOG.md": "Changelog",
  "FAQ.md": "FAQ",
};

function pathToTitle(source: string): string {
  if (TITLE_MAP[source]) return TITLE_MAP[source];

  const filename = source.split("/").pop() || source;
  return filename
    .replace(/\.(md|mdx|ts|json)$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pathToUrl(source: string): string {
  const slug = source
    .replace(/^(playground\/)?docs\//, "docs/")
    .replace(/^(playground\/)?spec\//, "spec/")
    .replace(/\.(md|mdx)$/, "")
    .replace(/\.zh$/, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

  return `${BASE_URL}/${slug}`;
}

export async function express(input: SourceLinkerInput): Promise<SourceLinkerOutput> {
  const sources = input.sources || [];
  const seen = new Set<string>();
  const links: SourceLink[] = [];

  for (const source of sources) {
    const normalized = source.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    links.push({
      title: pathToTitle(normalized),
      url: pathToUrl(normalized),
    });
  }

  return {
    text: input.answer || "",
    links,
    confidence: input.confidence ?? 0,
  };
}
