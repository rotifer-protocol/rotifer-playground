---
name: design-tokens
description: Parameterized design token system. Dynamically generates CSS variables for colors, border-radius, spacing, and typography based on brand parameters.
---

# Design Tokens

**Purpose**: UI design foundation layer that dynamically generates design variables from style parameters.

**Core Value**: Automatic mapping from style dimension values to concrete CSS variables.

---

## Design Philosophy

**Core Principle**: Parameter-driven, not hardcoded presets.

| Principle | Description |
|-----------|-------------|
| Parameter mapping | 0-100 dimension values automatically convert to concrete CSS values |
| Transparent formulas | Mapping logic is clear and predictable |
| Fine-tunable | Generated values can still be manually adjusted |
| Backward compatible | Default values used when parameters are unspecified |

---

## Parameter to Token Mapping

### Input: Style Parameters

```typescript
interface DesignTokenInput {
  primaryHue?: number;       // 0-360 (HSL hue)
  mode?: "light" | "dark";   // Color mode
  density?: "compact" | "normal" | "spacious";  // Spacing density
  borderRadius?: "sharp" | "rounded" | "pill";  // Border radius style
}
```

### Output: CSS Variables

```css
:root {
  /* Colors */
  --color-primary: ...;
  --color-surface: ...;
  --color-text: ...;

  /* Spacing */
  --space-0 through --space-9: ...;

  /* Border Radius */
  --radius-sm: ...;
  --radius-md: ...;
  --radius-lg: ...;
  --radius-full: ...;

  /* Typography */
  --font-sans: ...;
  --font-mono: ...;
  --text-xs through --text-3xl: ...;

  /* Shadows */
  --shadow-sm through --shadow-xl: ...;
}
```

---

## Mapping Formula Details

### 1. Color Palette Generation (primaryHue + mode → CSS)

```typescript
function generatePalette(hue: number, dark: boolean) {
  // Generates 15 color tokens from a single hue value
  // Dark mode inverts lightness values
  // Complementary accent color at hue+30°
  return {
    '--color-bg': hsl(hue, saturation, lightness),
    '--color-surface': ...,
    '--color-primary': hsl(hue, 70, dark ? 55 : 45),
    '--color-accent': hsl((hue + 30) % 360, 60, ...),
    // ... 15 total color tokens
  };
}
```

### 2. Spacing Scale (density → CSS)

```typescript
function generateSpacing(density: string) {
  // base: compact=4px, normal=6px, spacious=8px
  // scale multipliers: [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12]
  // Generates --space-0 through --space-9
}
```

| Density | Base | --space-2 | --space-4 | --space-6 |
|---------|------|-----------|-----------|-----------|
| compact | 4px | 4px | 12px | 24px |
| normal | 6px | 6px | 18px | 36px |
| spacious | 8px | 8px | 24px | 48px |

### 3. Border Radius (borderRadius → CSS)

| Style | --radius-sm | --radius-md | --radius-lg | --radius-full |
|-------|-------------|-------------|-------------|---------------|
| sharp | 2px | 4px | 6px | 8px |
| rounded | 4px | 8px | 12px | 9999px |
| pill | 9999px | 9999px | 9999px | 9999px |

### 4. Typography (fixed, does not vary with parameters)

```css
:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  --text-xs: 0.75rem;    /* 12px */
  --text-sm: 0.875rem;   /* 14px */
  --text-base: 1rem;     /* 16px */
  --text-lg: 1.125rem;   /* 18px */
  --text-xl: 1.25rem;    /* 20px */
  --text-2xl: 1.5rem;    /* 24px */
  --text-3xl: 2rem;      /* 32px */

  --line-height-tight: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;
}
```

### 5. Shadows (mode → CSS)

Shadow opacity scales with light/dark mode:

```typescript
function generateShadows(dark: boolean) {
  const opacity = dark ? 0.5 : 0.1;
  return {
    '--shadow-sm': `0 1px 2px rgba(0,0,0,${opacity})`,
    '--shadow-md': `0 4px 6px rgba(0,0,0,${opacity})`,
    '--shadow-lg': `0 10px 15px rgba(0,0,0,${opacity})`,
    '--shadow-xl': `0 20px 25px rgba(0,0,0,${opacity})`,
  };
}
```

---

## Usage Examples

### Generate from Parameters

```typescript
import { express } from './index';

const result = await express({
  primaryHue: 220,       // Blue
  mode: 'dark',
  density: 'normal',
  borderRadius: 'rounded'
});

console.log(result.css);        // Full :root { ... } block
console.log(result.totalTokens); // Number of generated tokens
```

### Use in Components

```html
<button style="
  background: var(--color-primary);
  color: var(--color-primary-fg);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-4);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  box-shadow: var(--shadow-md);
">
  Button
</button>
```

---

## Default Tokens

When no parameters are specified, defaults are used:
- `primaryHue`: 220 (blue)
- `mode`: "dark"
- `density`: "normal"
- `borderRadius`: "rounded"

This generates approximately 48 CSS custom properties covering colors, spacing, radii, typography, and shadows.

---

## Tailwind CSS Integration

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
        surface: 'var(--color-surface)',
        accent: 'var(--color-accent)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
    },
  },
}
```
