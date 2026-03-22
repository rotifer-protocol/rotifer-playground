# url-extractor

A Native Gene that extracts and categorizes all URLs from text content.

## Usage

```bash
rotifer test url-extractor --input '{
  "text": "Visit https://rotifer.dev for docs. Contact dev@rotifer.dev for help.",
  "includeEmails": true
}'
```

## Features

- Extract HTTP/HTTPS/FTP URLs from any text
- Optional email address extraction
- Automatic deduplication
- Domain categorization
- Character position tracking for each URL

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to extract URLs from |
| `includeEmails` | boolean | No | Also extract emails (default: false) |
| `deduplicate` | boolean | No | Remove duplicates (default: true) |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `urls` | array | Extracted URLs with protocol, domain, position |
| `emails` | array | Extracted emails (if enabled) |
| `totalFound` | number | Total URL count |
| `uniqueDomains` | string[] | List of unique domains found |
