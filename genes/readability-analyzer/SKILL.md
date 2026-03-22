---
name: readability-analyzer
description: Analyze and improve content readability. Evaluate sentence complexity, word choice, and overall accessibility. Use when ensuring content is appropriate for target audience reading level.
---

# Readability Analyzer

**Goal**: Analyze and improve content readability, ensuring text is easy to understand for the target audience.

---

## 1. Readability Metrics

### Flesch Reading Ease

```markdown
## Formula

FRE = 206.835 - 1.015 × (total words / total sentences) - 84.6 × (total syllables / total words)

## Score Interpretation

| Score | Difficulty | Grade Level | Example |
|-------|-----------|-------------|---------|
| 90-100 | Very easy | 5th grade | Children's books |
| 80-90 | Easy | 6th grade | Conversational |
| 70-80 | Fairly easy | 7th grade | Popular media |
| 60-70 | Standard | 8th-9th grade | Newspapers |
| 50-60 | Fairly difficult | 10th-12th grade | Academic |
| 30-50 | Difficult | College | Professional literature |
| 0-30 | Very difficult | Graduate+ | Legal documents |

## Target Scores

- General audience: 60-70
- Business documents: 50-60
- Academic papers: 30-50
```

### Flesch-Kincaid Grade Level

```markdown
## Formula

FKGL = 0.39 × (total words / total sentences) + 11.8 × (total syllables / total words) - 15.59

## Interpretation

The result represents the US grade level required to read the text.
Example: FKGL = 8.0 means 8th grade reading ability is needed.

## Recommendations

- General audience: Grade 6-8
- Professional content: Grade 10-12
- Academic articles: Grade 12+
```

---

## 2. Assessment Methods

### Automated Analysis Tools

```markdown
## English Tools

| Tool | Features | Link |
|------|----------|------|
| Hemingway Editor | Simplicity analysis | hemingwayapp.com |
| Grammarly | Comprehensive analysis | grammarly.com |
| Readable | Detailed reports | readable.com |
| Yoast SEO | WordPress plugin | |

## Manual Assessment

1. Calculate average sentence length
2. Count technical terms
3. Evaluate structural clarity
4. Have target readers review the text
```

### Assessment Report Template

```markdown
## Readability Analysis Report

### Basic Statistics
- Total word count:
- Total sentence count:
- Total paragraph count:
- Average sentence length:
- Average paragraph length:

### Metric Scores
- Flesch Reading Ease: /100
- Estimated grade level:
- Reading time: approx. X minutes

### Issues Found
- Overly long sentences: X instances
- Complex vocabulary: X words
- Passive voice: X instances
- Long paragraphs: X instances

### Recommendations
1.
2.
3.
```

---

## 3. Optimization Strategies

### Sentence Optimization

```markdown
## Break Up Long Sentences

Before: Due to the rapid development of artificial intelligence technology in recent years, particularly the breakthrough progress in deep learning and natural language processing, machines have become increasingly capable of accurately understanding and generating human language, which has had a profound impact on traditional industries such as translation, customer service, and content creation.

After: Artificial intelligence has developed rapidly in recent years. Deep learning and NLP have achieved breakthrough progress. Machines can now understand and generate human language with increasing accuracy. This has profoundly impacted translation, customer service, and content creation.

## Principles

- One idea per sentence
- Aim for 15-20 words per sentence in English
- Use short sentences for rhythm variation
```

### Vocabulary Simplification

```markdown
## Replace Complex Words

| Complex | Simple |
|---------|--------|
| utilize | use |
| implement | do / carry out |
| commence | start / begin |
| facilitate | help |
| demonstrate | show |

## Explain Technical Terms

Bad: The system uses a RAG architecture.

Good: The system uses Retrieval-Augmented Generation (RAG) — it first retrieves relevant information, then generates answers based on those results.

## Avoid Jargon Overload

Bad: Leverage AI-powered SaaS platform for B2B digital transformation...

Good: Use intelligent online software to help businesses go digital...
```

### Structure Optimization

```markdown
## Use Subheadings

Bad: Large blocks of plain text

Good:
### Problem Background
[Short paragraph]

### Solution
[Short paragraph]

### Implementation Steps
[List]

## Use Lists

Bad: We need to consider cost, time, quality, and risk factors.

Good: Consider the following factors:
- Cost
- Time
- Quality
- Risk

## Use Transition Words

First... Next... Finally...
Therefore... However... Additionally...
```

---

## 4. Audience Adaptation

### Adjust by Audience

```markdown
## General Public

- Sentence length: < 20 words
- Technical terms: minimal
- Structure: simple and direct
- Examples: use frequently

## Professionals

- Sentence length: moderate
- Technical terms: industry standard
- Structure: logical and rigorous
- Examples: precise

## Academic Readers

- Sentence length: can be longer
- Technical terms: specialized and formal
- Structure: well-argued
- Citations: complete and proper
```

### Genre Adaptation

```markdown
## News/Media
- Flesch: 60-70
- Sentence length: 15-20 words
- Style: concise and objective

## Business Documents
- Flesch: 50-60
- Sentence length: 18-22 words
- Style: professional and clear

## Technical Documentation
- Flesch: 40-50
- Sentence length: 20-25 words
- Style: accurate and detailed

## Academic Papers
- Flesch: 30-40
- Sentence length: 25-30 words
- Style: rigorous and formal
```

---

## 5. Visual Readability

### Typography Recommendations

```markdown
## Line Length

- Optimal: 45-75 characters per line
- Too long causes reading fatigue

## Line Height

- Recommended: 1.5-2x line spacing
- Body text: 1.5x
- Headings: 1.2x

## Paragraph Spacing

- Leave one blank line between paragraphs
- More space before subheadings

## Font

- Body: sans-serif font
- Size: 14-16px
- Contrast: sufficient clarity
```

### Formatting Elements

```markdown
## Effective Use

- Bullet lists
- Numbered steps
- Comparison tables
- Code blocks
- Blockquotes
- Selective bold text

## Avoid

- Bold everywhere
- Too many colors
- Mixed fonts
- Lack of whitespace
```

---

## 6. Checklist

```markdown
## Readability Checklist

### Sentence Level
- [ ] Average sentence length is moderate
- [ ] No overly long sentences (>40 words)
- [ ] Varied sentence structures
- [ ] Clear logic

### Vocabulary Level
- [ ] Technical terms are explained
- [ ] Word choice is concise
- [ ] No obscure expressions
- [ ] Vocabulary suits the audience

### Structure Level
- [ ] Subheadings used
- [ ] Paragraph length is moderate
- [ ] Logical hierarchy is clear
- [ ] Transitions connect ideas

### Visual Level
- [ ] Clean layout
- [ ] Sufficient whitespace
- [ ] Consistent formatting
- [ ] Lists and tables used where appropriate
```

---

## Quick Reference

### Readability Quick Check

```markdown
1. Sentence > 40 words? → Split it
2. Paragraph > 5 sentences? → Break it up
3. Unexplained jargon? → Add explanation
4. Long text wall? → Add subheadings
5. Can content be listed? → Convert to list
```

### Target Scores by Context

| Context | Flesch Score | Avg Sentence Length |
|---------|-------------|---------------------|
| Social media | 70-80 | 10-15 words |
| Blog posts | 60-70 | 15-20 words |
| Business emails | 55-65 | 18-22 words |
| Technical docs | 45-55 | 20-25 words |
| Academic papers | 30-45 | 25-30 words |

### Reading Time Estimation

```markdown
English: approx. 200-250 words/minute

Formula:
Reading time = Total words / Reading speed
```
