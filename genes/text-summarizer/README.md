# text-summarizer

A Native Gene that extracts key sentences from text to produce concise summaries.

## Usage

```bash
rotifer test text-summarizer --input '{"text": "Long article content here...", "maxWords": 50}'
```

## Features

- Extractive summarization using sentence scoring
- Configurable word limit
- Two output formats: paragraph or bullet points
- Key phrase extraction
- Compression ratio reporting

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | The text to summarize |
| `maxWords` | number | No | Maximum words (default: 100) |
| `format` | string | No | `"paragraph"` or `"bullets"` |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `summary` | string | The generated summary |
| `wordCount` | number | Word count of summary |
| `compressionRatio` | number | Summary/original length ratio |
| `keyPhrases` | string[] | Extracted key phrases |
