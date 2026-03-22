interface DesignTokenInput {
  primaryHue?: number;
  mode?: "light" | "dark";
  density?: "compact" | "normal" | "spacious";
  borderRadius?: "sharp" | "rounded" | "pill";
}

interface DesignTokenOutput {
  css: string;
  tokens: Record<string, string>;
  totalTokens: number;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

function generatePalette(hue: number, dark: boolean): Record<string, string> {
  const bg = dark ? hsl(hue, 5, 5) : hsl(hue, 10, 99);
  const surface = dark ? hsl(hue, 5, 8) : hsl(hue, 8, 96);
  const surfaceHover = dark ? hsl(hue, 5, 12) : hsl(hue, 8, 93);
  const border = dark ? hsl(hue, 6, 15) : hsl(hue, 10, 88);
  const borderHover = dark ? hsl(hue, 6, 25) : hsl(hue, 10, 75);
  const text = dark ? hsl(hue, 5, 96) : hsl(hue, 8, 8);
  const textMuted = dark ? hsl(hue, 4, 60) : hsl(hue, 5, 40);
  const textDim = dark ? hsl(hue, 3, 40) : hsl(hue, 4, 60);
  const primary = hsl(hue, 70, dark ? 55 : 45);
  const primaryHover = hsl(hue, 70, dark ? 60 : 40);
  const primaryForeground = dark ? hsl(hue, 5, 5) : hsl(0, 0, 100);
  const accent = hsl((hue + 30) % 360, 60, dark ? 50 : 45);
  const destructive = hsl(0, 70, dark ? 55 : 45);
  const success = hsl(140, 60, dark ? 50 : 40);
  const warning = hsl(40, 80, dark ? 55 : 45);

  return {
    "--color-bg": bg,
    "--color-surface": surface,
    "--color-surface-hover": surfaceHover,
    "--color-border": border,
    "--color-border-hover": borderHover,
    "--color-text": text,
    "--color-text-muted": textMuted,
    "--color-text-dim": textDim,
    "--color-primary": primary,
    "--color-primary-hover": primaryHover,
    "--color-primary-fg": primaryForeground,
    "--color-accent": accent,
    "--color-destructive": destructive,
    "--color-success": success,
    "--color-warning": warning,
  };
}

function generateSpacing(density: string): Record<string, string> {
  const base = density === "compact" ? 4 : density === "spacious" ? 8 : 6;
  const scale = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12];
  const tokens: Record<string, string> = {};
  scale.forEach((m, i) => {
    tokens[`--space-${i}`] = `${Math.round(base * m)}px`;
  });
  return tokens;
}

function generateRadius(style: string): Record<string, string> {
  const values: Record<string, Record<string, string>> = {
    sharp: { "--radius-sm": "2px", "--radius-md": "4px", "--radius-lg": "6px", "--radius-full": "8px" },
    rounded: { "--radius-sm": "4px", "--radius-md": "8px", "--radius-lg": "12px", "--radius-full": "9999px" },
    pill: { "--radius-sm": "9999px", "--radius-md": "9999px", "--radius-lg": "9999px", "--radius-full": "9999px" },
  };
  return values[style] || values.rounded;
}

function generateTypography(): Record<string, string> {
  return {
    "--font-sans": "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    "--font-mono": "'JetBrains Mono', 'Fira Code', monospace",
    "--text-xs": "0.75rem",
    "--text-sm": "0.875rem",
    "--text-base": "1rem",
    "--text-lg": "1.125rem",
    "--text-xl": "1.25rem",
    "--text-2xl": "1.5rem",
    "--text-3xl": "2rem",
    "--line-height-tight": "1.25",
    "--line-height-normal": "1.5",
    "--line-height-relaxed": "1.75",
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
  };
}

function generateShadows(dark: boolean): Record<string, string> {
  const opacity = dark ? 0.5 : 0.1;
  return {
    "--shadow-sm": `0 1px 2px rgba(0,0,0,${opacity})`,
    "--shadow-md": `0 4px 6px rgba(0,0,0,${opacity})`,
    "--shadow-lg": `0 10px 15px rgba(0,0,0,${opacity})`,
    "--shadow-xl": `0 20px 25px rgba(0,0,0,${opacity})`,
  };
}

/**
 * Design Tokens Gene
 *
 * Generates a complete CSS custom property system from brand parameters.
 * Pure HSL math and scale calculations — no external dependencies.
 */
export async function express(input: DesignTokenInput): Promise<DesignTokenOutput> {
  const hue = input.primaryHue ?? 220;
  const dark = (input.mode ?? "dark") === "dark";
  const density = input.density ?? "normal";
  const radius = input.borderRadius ?? "rounded";

  const tokens: Record<string, string> = {
    ...generatePalette(hue, dark),
    ...generateSpacing(density),
    ...generateRadius(radius),
    ...generateTypography(),
    ...generateShadows(dark),
  };

  const lines = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`);
  const css = `:root {\n${lines.join("\n")}\n}`;

  return { css, tokens, totalTokens: Object.keys(tokens).length };
}
