# json-validator

A Native Gene that validates JSON data against a JSON Schema definition.

## Usage

```bash
rotifer test json-validator --input '{
  "data": {"name": "Alice", "age": "not-a-number"},
  "schema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "number"}
    },
    "required": ["name", "age"]
  }
}'
```

## Features

- Full JSON Schema Draft-07 validation
- Detailed error messages with JSON path locations
- Strict mode for disallowing extra properties
- Nested schema support

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | any | Yes | The JSON data to validate |
| `schema` | object | Yes | JSON Schema definition |
| `strict` | boolean | No | Disallow additional properties (default: false) |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | Whether validation passed |
| `errors` | array | Validation errors with path, message, keyword |
| `errorCount` | number | Total error count |
