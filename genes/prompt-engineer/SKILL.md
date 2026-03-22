---
name: prompt-engineer
description: Design and optimize AI prompts for maximum effectiveness and cost efficiency. Create structured outputs, few-shot examples, and prompt templates. Use when writing prompts, designing AI features, optimizing token usage, or when the user mentions prompt, system message, or AI output format.
---

# Prompt Engineer (提示词工程师)

**Goal**: 设计高效、稳定、低成本的 AI 提示词，确保输出质量和一致性。

---

## Pre-Design Checklist

```
Prompt Design Check:
- [ ] 任务目标明确？(做什么)
- [ ] 输出格式定义？(JSON/Markdown/自然语言)
- [ ] 有 Few-shot 示例？
- [ ] Token 成本评估？
- [ ] 边界情况处理？(拒绝/不确定/超长)
```

---

## 1. Prompt Structure (提示词结构)

### 标准模板

```typescript
const PROMPT_TEMPLATE = `
# Role
{角色定义 - 1-2句}

# Task
{任务描述 - 清晰具体}

# Context
{背景信息 - 仅包含必要信息}

# Output Format
{输出格式 - 结构化定义}

# Examples
{Few-shot 示例 - 2-3个}

# Constraints
{约束条件 - 禁止事项}

# Input
{用户输入}
`
```

### 结构化输出 (JSON Schema)

```typescript
// 使用 Zod 定义 Schema
import { z } from 'zod'

const AnalysisSchema = z.object({
  summary: z.string().describe('一句话总结'),
  keyPoints: z.array(z.string()).max(5).describe('关键要点'),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
})

// Vercel AI SDK 用法
import { generateObject } from 'ai'

const result = await generateObject({
  model: openai('gpt-4o'),
  schema: AnalysisSchema,
  prompt: userInput,
})
```

### OpenAI Function Calling

```typescript
const tools = [{
  type: 'function',
  function: {
    name: 'extract_entities',
    description: 'Extract named entities from text',
    parameters: {
      type: 'object',
      properties: {
        persons: { type: 'array', items: { type: 'string' } },
        organizations: { type: 'array', items: { type: 'string' } },
        locations: { type: 'array', items: { type: 'string' } },
      },
      required: ['persons', 'organizations', 'locations'],
    },
  },
}]
```

---

## 2. Prompt Patterns (提示词模式)

### Chain of Thought (CoT)

```
Let's think step by step:
1. First, analyze...
2. Then, consider...
3. Finally, conclude...
```

### Few-Shot Learning

```typescript
const FEW_SHOT_PROMPT = `
# Task
Classify the sentiment of the text.

# Examples
Input: "This product exceeded my expectations!"
Output: { "sentiment": "positive", "confidence": 0.95 }

Input: "Terrible experience, never buying again."
Output: { "sentiment": "negative", "confidence": 0.92 }

Input: "It works as described."
Output: { "sentiment": "neutral", "confidence": 0.78 }

# Input
${userInput}
`
```

### Role Prompting

```typescript
const EXPERT_ROLE = `
You are a senior blockchain security auditor with 10+ years of experience.
You specialize in identifying vulnerabilities in smart contracts.
You are methodical, thorough, and always explain your reasoning.
`
```

### Output Constraints

```typescript
const OUTPUT_CONSTRAINTS = `
# Constraints
- Response must be valid JSON
- Maximum 3 key points
- Each point under 50 words
- Use professional tone
- If unsure, say "Unable to determine" instead of guessing
`
```

---

## 3. Token Optimization (成本优化)

### 精简原则

| Before | After | 节省 |
|--------|-------|------|
| "I want you to..." | (删除) | ~5 tokens |
| "Please provide..." | (直接说) | ~3 tokens |
| 重复的上下文 | 引用变量 | ~50% |
| 完整示例 x 5 | 精选示例 x 2 | ~60% |

### 动态上下文

```typescript
// 根据任务复杂度选择示例数量
function buildPrompt(task: string, complexity: 'low' | 'medium' | 'high') {
  const exampleCount = { low: 1, medium: 2, high: 3 }[complexity]
  const examples = EXAMPLES.slice(0, exampleCount)
  
  return `
    ${SYSTEM_PROMPT}
    ${examples.map(formatExample).join('\n')}
    ${task}
  `
}
```

### 压缩长文本

```typescript
// 先用小模型压缩，再用大模型分析
async function analyzeDocument(doc: string) {
  // Step 1: 压缩 (便宜)
  const summary = await generateText({
    model: openai('gpt-4o-mini'),
    prompt: `Summarize in 200 words: ${doc}`,
  })
  
  // Step 2: 深度分析 (贵)
  const analysis = await generateObject({
    model: openai('gpt-4o'),
    schema: AnalysisSchema,
    prompt: `Analyze: ${summary}`,
  })
  
  return analysis
}
```

---

## 4. Prompt Templates Library

### 内容生成

```typescript
const CONTENT_GENERATION = `
# Role
You are a professional content writer.

# Task
Write a {contentType} about {topic}.

# Requirements
- Tone: {tone}
- Length: {wordCount} words
- Audience: {audience}
- Include: {mustInclude}

# Format
Return as markdown with proper headings.
`
```

### 数据提取

```typescript
const DATA_EXTRACTION = `
# Task
Extract structured data from the following text.

# Output Schema
{
  "field1": "description",
  "field2": "description",
  ...
}

# Rules
- If a field is not found, use null
- Dates in ISO 8601 format
- Numbers without units

# Text
{inputText}
`
```

### 代码生成

```typescript
const CODE_GENERATION = `
# Role
You are a senior {language} developer.

# Task
{taskDescription}

# Requirements
- Use {framework}
- Follow {styleGuide}
- Include error handling
- Add TypeScript types

# Output
Return only the code, no explanations.
Use \`\`\`{language} code blocks.
`
```

### 分类/判断

```typescript
const CLASSIFICATION = `
# Task
Classify the input into one of the following categories:
{categories}

# Rules
- Choose exactly one category
- Include confidence score (0-1)
- If unsure (confidence < 0.6), choose "unknown"

# Output Format
{ "category": "...", "confidence": 0.XX, "reasoning": "..." }

# Input
{input}
`
```

---

## 5. Testing & Iteration

### Prompt 测试矩阵

| 测试维度 | 检查点 |
|----------|--------|
| 正常输入 | 预期输出正确 |
| 边界输入 | 空/超长/特殊字符 |
| 对抗输入 | Prompt 注入尝试 |
| 一致性 | 相同输入多次运行 |

### 版本管理

```typescript
// prompts/v1/analyzer.ts
export const ANALYZER_PROMPT_V1 = `...`

// prompts/v2/analyzer.ts (优化版)
export const ANALYZER_PROMPT_V2 = `...`

// prompts/index.ts
export { ANALYZER_PROMPT_V2 as ANALYZER_PROMPT } from './v2/analyzer'
```

### A/B 测试

```typescript
async function runPromptABTest(input: string) {
  const [resultA, resultB] = await Promise.all([
    generateWithPrompt(PROMPT_V1, input),
    generateWithPrompt(PROMPT_V2, input),
  ])
  
  logToAnalytics({
    input,
    resultA,
    resultB,
    // 人工评估或自动评估
  })
}
```

---

## 6. Common Mistakes (常见错误)

### ❌ 避免

```typescript
// 太模糊
"Help me with this text"

// 太啰嗦
"I would really appreciate it if you could kindly..."

// 无结构
"Analyze this and give me insights"

// 无示例
"Extract the data" (什么格式？)
```

### ✅ 正确

```typescript
// 明确具体
"Extract all company names and their founding years"

// 直接
"Summarize in 3 bullet points"

// 结构化
"Return JSON: { companies: [{ name, year }] }"

// 有示例
"Example: 'Apple founded 1976' → { name: 'Apple', year: 1976 }"
```

---

## Quick Reference

### 模型选择

| 任务类型 | 推荐模型 | 理由 |
|----------|----------|------|
| 简单分类 | gpt-4o-mini | 快、便宜 |
| 复杂推理 | gpt-4o / claude-3.5-sonnet | 质量高 |
| 代码生成 | gpt-4o / claude-3.5-sonnet | 准确性 |
| 长文本 | claude-3.5-sonnet | 200k context |

### Token 估算

```
英文: ~4 chars = 1 token
中文: ~1.5 chars = 1 token
代码: ~3 chars = 1 token
```

### 常用 System Prompts

```typescript
// 严格 JSON
"You are a JSON generator. Output valid JSON only, no markdown."

// 简洁回答
"Be concise. Answer in 1-2 sentences maximum."

// 拒绝回答
"If you cannot answer confidently, respond with: { error: 'Unable to determine' }"
```
