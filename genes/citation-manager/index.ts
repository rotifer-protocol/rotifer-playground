interface Source {
  type: "book" | "article" | "website" | "conference";
  authors: string[];
  title: string;
  year: number;
  journal?: string;
  volume?: number;
  issue?: number;
  pages?: string;
  publisher?: string;
  url?: string;
  accessDate?: string;
  conference?: string;
  doi?: string;
}

interface CitationInput {
  sources: Source[];
  style: "apa" | "mla" | "chicago";
}

interface CitationOutput {
  formatted: string[];
  bibliography: string;
  style: string;
  sourceCount: number;
}

function formatAuthorsAPA(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return invertName(authors[0]);
  if (authors.length === 2) return `${invertName(authors[0])} & ${invertName(authors[1])}`;
  if (authors.length <= 20) {
    const all = authors.map(invertName);
    return all.slice(0, -1).join(", ") + ", & " + all[all.length - 1];
  }
  return authors.slice(0, 19).map(invertName).join(", ") + ", ... " + invertName(authors[authors.length - 1]);
}

function formatAuthorsMLA(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return invertName(authors[0]);
  if (authors.length === 2) return `${invertName(authors[0])}, and ${authors[1]}`;
  return `${invertName(authors[0])}, et al.`;
}

function formatAuthorsChicago(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return invertName(authors[0]);
  if (authors.length <= 3) {
    const all = authors.map((a, i) => (i === 0 ? invertName(a) : a));
    return all.slice(0, -1).join(", ") + ", and " + all[all.length - 1];
  }
  return `${invertName(authors[0])} et al.`;
}

function invertName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts.pop()!;
  const initials = parts.map((p) => p[0].toUpperCase() + ".").join(" ");
  return `${last}, ${initials}`;
}

function formatAPA(source: Source): string {
  const authors = formatAuthorsAPA(source.authors);
  const year = `(${source.year})`;
  const title = source.title;

  switch (source.type) {
    case "book":
      return `${authors} ${year}. *${title}*. ${source.publisher || ""}.`.replace(/\.\./g, ".");
    case "article": {
      const journal = source.journal ? `*${source.journal}*` : "";
      const vol = source.volume ? `, *${source.volume}*` : "";
      const iss = source.issue ? `(${source.issue})` : "";
      const pages = source.pages ? `, ${source.pages}` : "";
      const doi = source.doi ? ` https://doi.org/${source.doi}` : "";
      return `${authors} ${year}. ${title}. ${journal}${vol}${iss}${pages}.${doi}`.replace(/\.\./g, ".");
    }
    case "website": {
      const url = source.url ? ` ${source.url}` : "";
      return `${authors} ${year}. ${title}.${url}`.replace(/\.\./g, ".");
    }
    case "conference":
      return `${authors} ${year}. ${title}. In *${source.conference || "Proceedings"}*.`.replace(/\.\./g, ".");
    default:
      return `${authors} ${year}. ${title}.`;
  }
}

function formatMLA(source: Source): string {
  const authors = formatAuthorsMLA(source.authors);
  const title = `"${source.title}"`;

  switch (source.type) {
    case "book":
      return `${authors}. *${source.title}*. ${source.publisher || ""}, ${source.year}.`.replace(/\.\./g, ".");
    case "article": {
      const journal = source.journal ? `*${source.journal}*` : "";
      const vol = source.volume ? `, vol. ${source.volume}` : "";
      const iss = source.issue ? `, no. ${source.issue}` : "";
      const pages = source.pages ? `, pp. ${source.pages}` : "";
      return `${authors}. ${title}. ${journal}${vol}${iss}, ${source.year}${pages}.`.replace(/\.\./g, ".");
    }
    case "website": {
      const url = source.url || "";
      const access = source.accessDate ? ` Accessed ${source.accessDate}.` : "";
      return `${authors}. ${title}. ${source.year}. ${url}.${access}`.replace(/\.\./g, ".");
    }
    case "conference":
      return `${authors}. ${title}. *${source.conference || "Conference"}*, ${source.year}.`.replace(/\.\./g, ".");
    default:
      return `${authors}. ${title}. ${source.year}.`;
  }
}

function formatChicago(source: Source): string {
  const authors = formatAuthorsChicago(source.authors);

  switch (source.type) {
    case "book":
      return `${authors}. *${source.title}*. ${source.publisher || ""}, ${source.year}.`.replace(/\.\./g, ".");
    case "article": {
      const journal = source.journal ? `*${source.journal}*` : "";
      const vol = source.volume ? ` ${source.volume}` : "";
      const iss = source.issue ? `, no. ${source.issue}` : "";
      const pages = source.pages ? `: ${source.pages}` : "";
      return `${authors}. "${source.title}." ${journal}${vol}${iss} (${source.year})${pages}.`.replace(/\.\./g, ".");
    }
    case "website": {
      const url = source.url ? ` ${source.url}` : "";
      const access = source.accessDate ? ` Accessed ${source.accessDate}.` : "";
      return `${authors}. "${source.title}." ${source.year}.${url}.${access}`.replace(/\.\./g, ".");
    }
    case "conference":
      return `${authors}. "${source.title}." In *${source.conference || "Proceedings"}*, ${source.year}.`.replace(/\.\./g, ".");
    default:
      return `${authors}. "${source.title}." ${source.year}.`;
  }
}

/**
 * Citation Manager Gene
 *
 * Formats academic citations in APA, MLA, and Chicago styles.
 * Pure string processing with no external dependencies.
 */
export async function express(input: CitationInput): Promise<CitationOutput> {
  const sources = input.sources || [];
  const style = input.style || "apa";

  if (sources.length === 0) {
    return { formatted: [], bibliography: "", style, sourceCount: 0 };
  }

  const formatter = style === "mla" ? formatMLA : style === "chicago" ? formatChicago : formatAPA;
  const formatted = sources.map(formatter);
  const bibliography = formatted.join("\n\n");

  return { formatted, bibliography, style, sourceCount: sources.length };
}
