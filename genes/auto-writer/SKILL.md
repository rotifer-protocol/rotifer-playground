---
name: auto-writer
description: Execute continuous AI-powered content generation with intelligent iteration loops. Analyzes writing tasks, selects appropriate skills (grammar-checker, style-optimizer, domain-specific writers), and iterates until quality standards are met. Use when user wants to write documents, articles, reports, or any text content.
---

# Auto Writer (智能持续写作)

**Goal**: 执行持续迭代的 AI 内容生成，通过智能循环和自动质量验证，实现自动化写作。

**定位**: 写作领域执行引擎，调用其他写作技能进行验证和优化。

---

## 使用方式

直接对 AI 说：

```
"使用 auto-writer 写一篇技术博客"
"用 auto-writer 帮我写年终总结"
"auto-writer 写一篇小红书种草文案"
"使用 auto-writer 写学术论文摘要"
```

AI 将自动：
1. 分析写作类型和目标受众
2. 选择合适的领域技能组合
3. 执行并迭代直到质量达标
4. 生成最终内容

> **注意**: 用户无需了解内部实现细节，AI 会自动选择最佳写作策略。

---

## AI 执行指南

> **本节供 AI 阅读**：当用户调用 auto-writer 时，按以下决策树自动选择能力。

### 能力选择决策树

```
用户请求
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. 写作类型判断                                              │
├─────────────────────────────────────────────────────────────┤
│ • 技术文档/README/API → docs-writer                         │
│ • 学术论文/研究报告 → academic-writer                       │
│ • 营销文案/自媒体 → copywriter                              │
│ • 商业报告/工作总结 → business-writer                       │
│ • 故事/剧本/创意 → creative-writer                          │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. 辅助需求判断                                              │
├─────────────────────────────────────────────────────────────┤
│ • 需要 SEO 优化 → + seo-optimizer                           │
│ • 需要引用管理 → + citation-manager                         │
│ • 需要翻译 → + translator                                   │
│ • 需要事实核查 → + fact-checker                             │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 质量验证                                                  │
├─────────────────────────────────────────────────────────────┤
│ • 语法检查 → grammar-checker [核心]                          │
│ • 风格优化 → style-optimizer [核心]                          │
│ • 查重检测 → plagiarism-checker [学术]                       │
│ • 可读性分析 → readability-analyzer [可选]                   │
│ • 语气匹配 → tone-analyzer [可选]                            │
└─────────────────────────────────────────────────────────────┘
```

### 写作类型速查

| 类型 | 技能 | 典型场景 |
|------|------|----------|
| **技术** | docs-writer | README、API 文档、技术博客 |
| **学术** | academic-writer | 论文、研究报告、文献综述 |
| **营销** | copywriter | 公众号、小红书、抖音脚本 |
| **商业** | business-writer | 周报、年终总结、BP |
| **创意** | creative-writer | 小说、剧本、故事 |

### 自适应质量评估

| 写作类型 | 核心验证 | 辅助验证 |
|----------|----------|----------|
| 技术文档 | grammar, style | readability |
| 学术论文 | grammar, style | plagiarism, citation |
| 营销文案 | grammar, style | seo, tone |
| 商业报告 | grammar, style | readability, tone |
| 创意写作 | grammar, style | tone |

---

## Core Workflow

```
分析任务 → 选择技能 → 生成内容 → 质量验证 → 迭代优化 → 完成
    ↓         ↓          ↓          ↓          ↓         ↓
识别类型  规划技能   撰写初稿   检查质量   修改完善   输出成品
```

> **详细说明**: [reference/CORE-WORKFLOW.md](reference/CORE-WORKFLOW.md)

### 质量验证循环

| 步骤 | 技能 | 触发条件 |
|------|------|----------|
| 1. Grammar | grammar-checker | [核心] 每次迭代 |
| 2. Style | style-optimizer | [核心] 每次迭代 |
| 3. Domain | 领域技能 | [条件] 按写作类型 |
| 4. Quality | 质量技能 | [条件] 按需求 |

### 停止条件

| 类型 | 条件 |
|------|------|
| 成功 | 所有验证通过、内容完整 |
| 失败 | 达到最大迭代 / 用户中断 |

---

## Skill Dependencies

### 核心技能（每次写作必调用）

| 技能 | 说明 |
|------|------|
| `grammar-checker` | 语法/拼写检查 |
| `style-optimizer` | 风格优化、可读性 |

### 领域技能（按写作类型触发）

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `docs-writer` | 技术文档时 | README、API 文档、技术博客 |
| `academic-writer` | 学术写作时 | 论文、研究报告、引用格式 |
| `copywriter` | 营销文案时 | 自媒体、广告、平台适配 |
| `business-writer` | 商业写作时 | 报告、总结、BP |
| `creative-writer` | 创意写作时 | 故事、剧本、叙事 |

### 辅助技能（按需求触发）

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `doc-coauthoring` | 协作文档时 | 文档协作流程 |
| `seo-optimizer` | Web 内容时 | 关键词、meta 优化 |
| `citation-manager` | 学术引用时 | 引用格式管理 |
| `translator` | 翻译需求时 | 中英互译、本地化 |
| `fact-checker` | 事实核查时 | 来源验证 |

### 质量技能（按场景触发）

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `plagiarism-checker` | 学术写作时 | 查重检测 |
| `readability-analyzer` | 正式文档时 | 可读性评估 |
| `tone-analyzer` | 受众敏感时 | 语气匹配检查 |

---

## Skill Planning (智能技能规划)

```
用户任务 → Task Analyzer → Skill Planner → 动态写作循环
              │                │
              ▼                ▼
      WritingTaskAnalysis   SkillPlan
```

### Task Analyzer 输出

```typescript
interface WritingTaskAnalysis {
  // 写作类型
  writingType: 'technical' | 'academic' | 'marketing' | 'business' | 'creative' | 'mixed'
  
  // 内容形式
  contentFormat: 'document' | 'article' | 'post' | 'email' | 'script' | 'other'
  
  // 目标平台
  targetPlatform: string | null  // 'wechat' | 'xiaohongshu' | 'douyin' | 'twitter' | null
  
  // 学术相关
  isAcademic: boolean
  citationStyle: 'apa' | 'mla' | 'chicago' | 'gb7714' | null
  needsPlagiarismCheck: boolean
  
  // 商业相关
  isBusiness: boolean
  hasDataVisualization: boolean
  
  // 营销相关
  isMarketing: boolean
  needsSEO: boolean
  hasCTA: boolean
  
  // 创意相关
  isCreative: boolean
  hasNarrative: boolean
  
  // 通用
  targetAudience: string
  formalityLevel: 'formal' | 'semi-formal' | 'casual'
  wordCountTarget: number | null
  needsTranslation: boolean
  needsFactCheck: boolean
}
```

### Skill Planner 规则

| 条件 | 调用的 Skill |
|------|-------------|
| 所有写作任务 | grammar-checker, style-optimizer [核心] |
| writingType = 'technical' | + docs-writer |
| writingType = 'academic' | + academic-writer, + citation-manager |
| writingType = 'marketing' | + copywriter |
| writingType = 'business' | + business-writer |
| writingType = 'creative' | + creative-writer |
| isAcademic = true | + plagiarism-checker |
| needsSEO = true | + seo-optimizer |
| needsTranslation = true | + translator |
| needsFactCheck = true | + fact-checker |
| formalityLevel = 'formal' | + tone-analyzer |
| 任务完成时 | + readability-analyzer |

---

## Usage Examples

### Example 1: 技术博客

```markdown
用户: "使用 auto-writer 写一篇关于 React Hooks 的技术博客"

流程:
1. 分析类型 → technical
2. 调用 docs-writer 生成结构
3. grammar-checker + style-optimizer 验证
4. 完成技术博客
```

### Example 2: 学术论文

```markdown
用户: "使用 auto-writer 写论文摘要，使用 APA 格式"

流程:
1. 分析类型 → academic
2. 调用 academic-writer + citation-manager
3. plagiarism-checker 查重
4. grammar-checker + style-optimizer 验证
5. 完成论文摘要
```

### Example 3: 小红书文案

```markdown
用户: "使用 auto-writer 写一篇小红书种草文案"

流程:
1. 分析类型 → marketing, 平台 → xiaohongshu
2. 调用 copywriter（使用小红书模板）
3. seo-optimizer 优化标签
4. tone-analyzer 检查语气
5. 完成文案
```

### Example 4: 年终总结

```markdown
用户: "使用 auto-writer 写年终工作总结"

流程:
1. 分析类型 → business
2. 调用 business-writer
3. readability-analyzer 检查可读性
4. grammar-checker + style-optimizer 验证
5. 完成总结
```

---

## Best Practices

### DO

- 每次迭代后检查语法和风格
- 根据写作类型选择合适的领域技能
- 验证内容符合目标受众
- 学术写作务必查重
- 营销文案注意平台适配

### DON'T

- 不检查语法就提交
- 忽略目标受众
- 学术写作不查重
- 忽略平台特性
- 不验证事实就发布

---

## Quick Reference

### 写作类型关键词

| 类型 | 关键词 |
|------|--------|
| 技术 | readme, api, 文档, documentation, 技术博客 |
| 学术 | 论文, paper, thesis, 研究, 学术, 摘要 |
| 营销 | 文案, 营销, 广告, 公众号, 小红书, 抖音 |
| 商业 | 报告, 总结, 周报, 月报, 年终, BP, OKR |
| 创意 | 故事, 小说, 剧本, script, 叙事 |

### 平台模板

| 平台 | 特点 |
|------|------|
| 公众号 | 标题党、长文、分段清晰 |
| 小红书 | emoji多、种草风、标签 |
| 抖音 | 口语化、节奏快、hook |
| Twitter/X | 简短、有力、thread |

---

## Integration with orch

在 `orch` 中注册：

```markdown
### 写作场景

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 写作、文案、文档、文章 | `auto-writer` | "帮我写一篇文章" |
| 技术文档（代码相关） | `auto-coder` | "给这个函数写注释" |
```

---

## Additional Resources

### 参考文档

| 文档 | 描述 |
|------|------|
| [reference/CORE-WORKFLOW.md](reference/CORE-WORKFLOW.md) | 完整写作工作流程 |

### 领域技能详情

| 技能 | 描述 |
|------|------|
| grammar-checker | 语法检查规则 |
| style-optimizer | 风格优化指南 |
| academic-writer | 学术写作规范 |
| copywriter | 营销文案模板 |
| business-writer | 商业写作结构 |
| creative-writer | 创意写作技巧 |
