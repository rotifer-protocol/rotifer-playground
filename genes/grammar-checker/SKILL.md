---
name: grammar-checker
description: Check grammar, spelling, and punctuation in written content. Identify common errors and provide corrections. Use when reviewing any written content for grammatical accuracy.
---

# Grammar Checker

**Goal**: Ensure content is free from grammar, spelling, and punctuation errors.

---

## 1. Common Grammar Errors

### English Common Errors

| Error Type | Incorrect | Correct |
|-----------|-----------|---------|
| Subject-Verb Agreement | The team are ready | The team **is** ready |
| Tense Consistency | I walked and talk | I walked and **talked** |
| Article Usage | I have apple | I have **an** apple |
| Run-on Sentences | I went home I was tired | I went home**;** I was tired |
| Comma Splice | It's hot, I'm sweating | It's hot**,** **so** I'm sweating |

### Commonly Confused Words

| Words | Difference |
|-------|-----------|
| affect / effect | affect (v.) to influence; effect (n.) result |
| their / there / they're | their = possessive; there = location; they're = they are |
| its / it's | its = possessive; it's = it is |
| your / you're | your = possessive; you're = you are |
| then / than | then = next; than = comparison |

---

## 2. Spelling Check

### Commonly Misspelled Words

```
accommodate ≠ accomodate
definitely ≠ definately
occurrence ≠ occurence
separate ≠ seperate
necessary ≠ neccessary
receive ≠ recieve
```

### Homophones

| Words | Context |
|-------|---------|
| to / too / two | to = direction; too = also/excessive; two = number |
| accept / except | accept = agree; except = exclude |
| principal / principle | principal = main/head; principle = rule/belief |
| complement / compliment | complement = complete; compliment = praise |

---

## 3. Punctuation Rules

### English Punctuation

```markdown
## Common Rules

1. Period (.) - End of declarative sentence
2. Comma (,) - Separating clauses, lists, introductory elements
3. Semicolon (;) - Connecting related independent clauses
4. Colon (:) - Introducing lists or explanations
5. Apostrophe (') - Possession, contractions
6. Quotation marks ("") - Direct speech, titles of short works
7. Hyphen (-) - Compound words (well-known)
8. En dash (–) - Ranges (pages 10–15)
9. Em dash (—) - Interruption, emphasis, parenthetical

## Key Rules

- Use Oxford comma in lists of three or more
- Place periods and commas inside quotation marks
- No space before punctuation marks
- One space after punctuation marks
```

---

## 4. Checklist

```markdown
## Grammar Check Checklist

### Basic Checks
- [ ] No spelling errors
- [ ] Punctuation used correctly
- [ ] Complete sentence structure
- [ ] Subject-verb agreement

### Advanced Checks
- [ ] Consistent verb tenses
- [ ] Correct word order
- [ ] Proper collocations
- [ ] No redundant expressions

### Formatting Checks
- [ ] Consistent punctuation style
- [ ] Uniform number formats
- [ ] Proper nouns capitalized correctly
```

---

## 5. Common Fix Patterns

### Fix Template

```markdown
## Issue: [Error Type]

**Original**: [Incorrect content]
**Problem**: [Description of the issue]
**Correction**: [Fixed content]
**Rule**: [Applicable rule]
```

### Examples

```markdown
## Issue: Subject-Verb Agreement

**Original**: The list of items are on the table.
**Problem**: "list" is the subject (singular), not "items"
**Correction**: The list of items **is** on the table.
**Rule**: Subject-verb agreement with prepositional phrases
```

```markdown
## Issue: Dangling Modifier

**Original**: Walking to school, the rain started.
**Problem**: The modifier "Walking to school" has no proper subject
**Correction**: Walking to school, **I** got caught in the rain.
**Rule**: Modifiers must clearly refer to the subject of the sentence
```

---

## Quick Reference

### Verb Tense Quick Guide

| Tense | Structure | Example |
|-------|-----------|---------|
| Simple Present | V / V-s | I write |
| Simple Past | V-ed | I wrote |
| Present Perfect | have/has + V-ed | I have written |
| Past Perfect | had + V-ed | I had written |
| Future | will + V | I will write |
| Present Continuous | am/is/are + V-ing | I am writing |

### Common Rules at a Glance

```markdown
1. a → before consonant sounds (a book, a university)
2. an → before vowel sounds (an apple, an hour)
3. Comma after introductory clauses
4. No comma before "that" in restrictive clauses
5. Use "who" for people, "which/that" for things
```

---

## Integration with auto-writer

```markdown
## When to Invoke

- After each writing iteration
- As a core validation step

## Output Format

{
  "hasErrors": boolean,
  "errorCount": number,
  "errors": [
    {
      "type": "spelling|grammar|punctuation",
      "original": "incorrect content",
      "suggestion": "suggested fix",
      "position": "position description"
    }
  ]
}
```
