# markdown-formatter

A Native Gene that normalizes Markdown formatting for consistency.

## Usage

```bash
rotifer test markdown-formatter --input '{"markdown": "# Title\n*  item1\n*  item2\n", "listMarker": "-"}'
```

## Features

- Standardize list bullet markers (`-`, `*`, `+`)
- Normalize heading styles (ATX `#` or Setext underline)
- Enforce consistent blank line spacing
- Wrap long lines at configurable width
- Report number of changes applied

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `markdown` | string | Yes | Raw Markdown text |
| `lineWidth` | number | No | Max line width (default: 80) |
| `listMarker` | string | No | Bullet char: `-`, `*`, or `+` |
| `headingStyle` | string | No | `"atx"` or `"setext"` |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `formatted` | string | Formatted Markdown |
| `changed` | boolean | Whether changes were made |
| `changeCount` | number | Number of changes applied |
