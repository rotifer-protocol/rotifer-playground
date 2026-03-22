# code-complexity

A Native Gene that measures source code complexity using industry-standard metrics.

## Usage

```bash
rotifer test code-complexity --input '{
  "code": "function example(x) {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {\n      if (i % 2 === 0) console.log(i);\n    }\n  }\n}",
  "language": "javascript",
  "threshold": 10
}'
```

## Metrics

| Metric | Description |
|--------|-------------|
| **Cyclomatic Complexity** | McCabe's complexity — number of independent paths through code |
| **Lines of Code** | Non-blank, non-comment lines |
| **Max Nesting Depth** | Deepest level of nested control structures |
| **Function Count** | Number of functions/methods |

## Rating Scale

| Score | Rating | Meaning |
|-------|--------|---------|
| 1-5 | Low | Simple, easy to maintain |
| 6-10 | Moderate | Manageable complexity |
| 11-20 | High | Consider refactoring |
| 21+ | Very High | Refactoring strongly recommended |

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go
