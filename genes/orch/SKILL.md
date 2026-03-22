---
name: orch
description: 智能技能调度中心，根据用户意图自动识别和调度最合适的技能。分析对话内容，匹配任务类型，组合多技能完成复杂任务。当用户提出需求但未明确指定技能、需要帮助选择技能、或执行跨技能任务时使用。
---

# Skill Orchestrator (智能技能调度中心)

## 定位

统一调度入口，根据用户意图自动路由到最合适的技能或技能组合。

**核心价值**：用户无需记住技能名称，只需描述需求，自动匹配最佳技能。

---

## 调度流程（混合模式）

采用**分层策略**：硬编码规则处理明确场景，LLM 语义理解处理模糊场景。

```
用户输入
    │
    ├─ 第1层：显式指定 (/skill-name) ──────────→ 直接调用
    │
    ├─ 第2层：强规则匹配（高置信关键词）────────→ 直接调用
    │         PRD、commit、部署、报错...
    │
    ├─ 第3层：LLM 语义理解（模糊/口语化表达）──→ 智能判断
    │         "搞定这个"、"看看这里"、上下文依赖...
    │
    └─ 第4层：询问用户 ────────────────────────→ 确认后调用
              仍然不确定时
```

### 分层优势

| 层级 | 方式 | 优势 | 适用场景 |
|------|------|------|----------|
| 第1层 | 显式指定 | 零歧义 | 用户明确知道要用哪个技能 |
| 第2层 | 硬编码规则 | 快速、可预测、零额外消耗 | 标准关键词 (PRD, commit, 部署) |
| 第3层 | LLM 语义 | 理解上下文、处理口语化表达 | 模糊表达 ("搞定", "弄一下") |
| 第4层 | 询问用户 | 确保准确 | 无法判断时 |

### 置信度阈值

| 置信度 | 行为 |
|--------|------|
| **高** (明确匹配) | 直接调用技能，告知用户 |
| **中** (多个可能) | 列出候选技能，让用户选择 |
| **低** (不确定) | 询问用户意图后再匹配 |

---

## 意图识别矩阵

### 产品阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| PRD、需求文档、产品规划、用户故事、MVP | `product-manager` | "帮我写个PRD" |
| 竞品分析、用户画像、优先级排序 | `product-manager` | "分析一下竞品" |

### 设计阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| UI 设计、界面设计、设计系统 | `uiux-designer` | "帮我设计登录页面" |
| 配色、字号、间距、设计令牌 | `design-tokens` | "定义项目的配色方案" |
| 按钮、输入框、卡片、表格、弹窗 | `ui-components` | "给我一个表格组件" |
| 动效、状态反馈、文案、交互 | `ux-patterns` | "优化这个页面的交互" |
| AI 聊天界面、Streaming、思考中 | `ai-components` | "做一个 AI 聊天界面" |
| 钱包连接、交易状态、Web3 界面 | `web3-components` | "设计钱包连接按钮" |

### 架构阶段（设计讨论，不写代码）

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| API 设计、接口规范、RESTful | `api-designer` | "设计用户API" |
| 数据库、Schema、Prisma、表结构 | `data-modeler` | "设计数据库模型" |
| 架构设计、怎么设计、设计思路、技术选型 | `logic-architect` | "这个功能怎么设计" |
| 代码评审、架构评审、逻辑检查（不实现） | `logic-architect` | "帮我看看这个设计合理吗" |

> ⚠️ **注意**: logic-architect 只做设计和评审，不写实现代码。如需写代码，使用 `auto-coder`。

### 开发阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| Prompt、AI 提示词、Token 优化 | `prompt-engineer` | "优化这个prompt" |
| 代码规范、命名、类型安全 | `tech-lead` | "检查代码规范" |
| commit、分支、PR | `git-workflow` | "帮我写commit信息" |
| **实现、写代码、开发、编写、帮我做** | `auto-coder` | "帮我实现登录功能" |
| **合并、迁移、整合、重构、改造** | `auto-coder` | "合并项目代码" |
| **添加、新增、创建、构建、升级** | `auto-coder` | "添加新功能" |
| 自动编程、持续迭代、一键完成 | `auto-coder` | "自动实现这个功能" |

### 质量阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 测试、单元测试、E2E | `testing-strategist` | "怎么测试这个功能" |
| 安全、漏洞、注入、权限 | `security-auditor` | "检查安全问题" |
| 性能、加载慢、优化 | `performance-optimizer` | "页面加载太慢" |
| Bug、报错、不工作 | `debugger` | "这里报错了" |

### 发布阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 文档、README、API 文档 | `docs-writer` | "写个README" |
| 部署、CI/CD、Docker | `devops-automator` | "配置自动部署" |
| 开源协议、LICENSE | `license-advisor` | "选什么协议" |

### 写作阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| **写文章、写文案、写报告、写论文** | `auto-writer` | "帮我写一篇技术博客" |
| **文章、博客、文案、年终总结** | `auto-writer` | "写年终工作总结" |
| **学术论文、摘要、研究报告** | `auto-writer` | "写论文摘要" |
| **小红书、公众号、抖音脚本** | `auto-writer` | "写一篇小红书种草文案" |
| **商业报告、BP、工作汇报** | `auto-writer` | "写商业计划书" |
| **故事、剧本、创意写作** | `auto-writer` | "写一个短篇故事" |
| 语法检查、拼写检查 | `grammar-checker` | "检查语法错误" |
| 风格优化、可读性 | `style-optimizer` | "优化这段文字" |
| 查重、原创性检测 | `plagiarism-checker` | "检查是否有抄袭" |

> ⚠️ **注意**: auto-writer 用于非代码的内容写作。技术文档（与代码相关的 README、API 文档）仍使用 `docs-writer`。

### 审查阶段

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 代码审查、项目审查、全面检查 | `project-reviewer` | "审查一下这个项目" |

### 执行场景（代码实现优先使用 auto-coder）

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| **帮我实现、帮我写、帮我做、帮我开发** | `auto-coder` | "帮我实现用户认证" |
| **实现 X 功能、写 X 代码、开发 X 模块** | `auto-coder` | "实现支付功能" |
| **一键完成、全部做完、写完整代码** | `auto-coder` | "帮我把登录功能写完" |
| **合并、迁移、整合、移植、搬迁** | `auto-coder` | "合并 A 项目到 B" |
| **重构、改造、升级、优化代码** | `auto-coder` | "重构认证模块" |
| **添加、新增、创建、构建** | `auto-coder` | "添加支付功能" |
| 自动编程、持续迭代、一键完成 | `auto-coder` | "自动实现这个功能" |
| 实现 + 测试 | `auto-coder` → `testing-strategist` | "实现并测试这个功能" |

### 特殊场景

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 写文档、协作、迭代 | `doc-coauthoring` | "帮我写技术文档" |
| 生成艺术、p5.js、算法艺术 | `algorithmic-art` | "生成一个流体动画" |

---

## 技能组合策略

### 端到端场景

| 场景 | 技能组合顺序 |
|------|-------------|
| 新功能开发 | `product-manager` → `logic-architect` → `api-designer` → `data-modeler` → 实现 |
| 自动实现功能 | `auto-coder` (智能规划：Task Analyzer → Skill Planner → 动态验证) |
| 安全敏感功能 | `auto-coder` (强制调用 security-auditor) |
| AI 功能开发 | `auto-coder` (自动调用 prompt-engineer + security-auditor) |
| Web3 功能开发 | `auto-coder` (强制调用 security-auditor，每次迭代) |
| 上线前检查 | `project-reviewer` → `security-auditor` → `performance-optimizer` → `testing-strategist` |
| 代码重构 | `auto-coder` (自动调用 logic-architect + tech-lead) |
| 新项目启动 | `product-manager` → `uiux-designer` → `api-designer` → `devops-automator` |
| UI 界面设计 | `uiux-designer` (智能调度子技能：design-tokens, ui-components, ux-patterns) |
| AI 应用界面 | `uiux-designer` → `ai-components` |
| Web3 DApp 界面 | `uiux-designer` → `web3-components` |
| 写作任务（非代码） | `auto-writer` (智能规划：Task Analyzer → Skill Planner → 动态验证) |
| 学术论文写作 | `auto-writer` (自动调用 academic-writer + citation-manager + plagiarism-checker) |
| 营销文案写作 | `auto-writer` (自动调用 copywriter + seo-optimizer + tone-analyzer) |
| 商业报告写作 | `auto-writer` (自动调用 business-writer + readability-analyzer) |

> **auto-coder 智能规划**：根据任务内容自动决定调用哪些技能，无需手动指定。
> - 核心技能（必选）：testing-strategist, tech-lead
> - 条件技能（按需）：security-auditor, logic-architect, prompt-engineer, performance-optimizer
> - 设计技能（复杂任务）：api-designer, data-modeler, uiux-designer

> **auto-writer 智能规划**：根据写作类型自动决定调用哪些技能，无需手动指定。
> - 核心技能（必选）：grammar-checker, style-optimizer
> - 领域技能（按类型）：docs-writer, academic-writer, copywriter, business-writer, creative-writer
> - 辅助技能（按需）：seo-optimizer, citation-manager, translator, fact-checker
> - 质量技能（按场景）：plagiarism-checker, readability-analyzer, tone-analyzer

### 组合触发词

| 触发词 | 组合 |
|--------|------|
| "从头开始做一个..." | product-manager → uiux-designer → auto-coder |
| "设计一个界面..." | uiux-designer (智能调度子技能) |
| "做一个 AI 聊天界面" | ai-components + auto-coder |
| "做一个 Web3 DApp 界面" | web3-components + auto-coder |
| "帮我实现..."、"帮我写..."、"帮我做..." | auto-coder (智能规划，按需调用技能) |
| "自动实现..."、"一键完成..." | auto-coder (智能规划，按需调用技能) |
| "实现登录/认证/支付..." | auto-coder (自动触发 security-auditor) |
| "实现钱包连接/Web3..." | auto-coder (强制调用 security-auditor) |
| "实现 AI 聊天/Prompt..." | auto-coder (自动调用 prompt-engineer + security-auditor) |
| "设计一下..."、"怎么设计..." | logic-architect (只做设计) |
| "准备上线" | project-reviewer → security-auditor → performance-optimizer |
| "全面审查" | project-reviewer (它会协调其他技能) |
| "重构这个模块" | auto-coder (自动调用 logic-architect) |
| "写一篇文章/博客/报告" | auto-writer (智能规划，按类型调用技能) |
| "写小红书/公众号文案" | auto-writer (自动调用 copywriter + seo-optimizer) |
| "写论文摘要/学术报告" | auto-writer (自动调用 academic-writer + plagiarism-checker) |
| "写年终总结/工作汇报" | auto-writer (自动调用 business-writer) |
| "写故事/剧本" | auto-writer (自动调用 creative-writer) |

---

## 调度决策树

```
用户输入
    │
    ├─ 第1层：明确指定技能 (/xxx)
    │   └── 直接使用该技能
    │
    ├─ 第2层：硬编码规则匹配
    │   │
    │   ├── 🔥 设计 vs 实现 快速判断
    │   │   ├── 有"实现/写/做/开发" → auto-coder
    │   │   └── 只有"设计/分析/评审" → logic-architect
    │   │
    │   ├── 关键词匹配（见意图识别矩阵）
    │   │   ├── 单一匹配 → 高置信度 → 直接调用
    │   │   └── 多个匹配 → 进入第3层
    │   │
    │   └── 无匹配 → 进入第3层
    │
    ├─ 第3层：LLM 语义理解 ← 处理模糊场景
    │   │
    │   │   使用下方【LLM 调度指令】分析用户意图
    │   │
    │   ├── LLM 高置信 → 直接调用
    │   ├── LLM 中置信 → 列出选项
    │   └── LLM 低置信 → 进入第4层
    │
    ├─ 第4层：询问用户
    │   └── 确认意图后再匹配
    │
    └─ 复杂任务识别（任意层级可触发）
        ├── 端到端场景 → 使用组合策略
        └── 审查类任务 → 委托给 project-reviewer
```

### 🔥 设计 vs 实现 快速判断（第2层规则）

| 用户说的话 | 意图 | 选择技能 |
|------------|------|----------|
| "帮我实现 X"、"写 X 代码"、"开发 X" | **实现** | `auto-coder` ✅ |
| "合并 A 到 B"、"迁移代码"、"整合项目" | **实现** | `auto-coder` ✅ |
| "重构 X"、"改造 X"、"升级 X" | **实现** | `auto-coder` ✅ |
| "添加 X 功能"、"新增 X"、"创建 X" | **实现** | `auto-coder` ✅ |
| "帮我做 X"、"完成 X 功能" | **实现** | `auto-coder` ✅ |
| "这个功能怎么设计"、"架构合理吗" | **设计** | `logic-architect` |
| "分析一下这个设计"、"技术选型建议" | **设计** | `logic-architect` |

---

### 🧠 LLM 调度指令（第3层语义理解）

当硬编码规则无法匹配时，使用以下指令进行语义分析：

<details>
<summary>展开 LLM 调度 Prompt</summary>

```
你是技能调度器。根据用户输入，选择最合适的技能。

## 可用技能

| 技能 | 用途 |
|------|------|
| auto-coder | 写代码、实现功能、修复代码、重构 |
| logic-architect | 设计讨论、架构分析、技术选型（不写代码）|
| debugger | 问题诊断、错误分析（不修复）|
| testing-strategist | 测试策略、写测试代码 |
| tech-lead | 代码规范检查、命名分析（不修改）|
| security-auditor | 安全审计、漏洞分析 |
| performance-optimizer | 性能分析、优化建议 |
| product-manager | PRD、需求、用户故事 |
| api-designer | API 设计、接口规范 |
| data-modeler | 数据库设计、Schema |
| uiux-designer | UI/UX 设计统一入口 |
| design-tokens | 设计令牌（配色/字号/间距）|
| ui-components | 基础组件模板 |
| ux-patterns | 交互模式、动效、文案 |
| ai-components | AI 界面组件 |
| web3-components | Web3 界面组件 |
| docs-writer | 文档、README |
| devops-automator | 部署、CI/CD |
| git-workflow | commit、分支、PR |
| prompt-engineer | Prompt 设计与优化 |
| project-reviewer | 全面项目审查 |
| auto-writer | 写文章、文案、报告、论文（非代码）|
| grammar-checker | 语法/拼写检查 |
| style-optimizer | 风格/可读性优化 |
| academic-writer | 学术论文写作 |
| copywriter | 营销文案写作 |
| business-writer | 商业报告写作 |
| creative-writer | 创意/故事写作 |

## 关键区分

- "搞定/弄好/做完" → 通常是 auto-coder
- "看看/分析/检查" → 通常是分析类技能（不写代码）
- "为什么/怎么回事" → 通常是 debugger
- "怎么设计/怎么做比较好" → logic-architect

## 用户输入

"{user_input}"

## 请回答（JSON 格式）

{
  "skill": "选择的技能名",
  "confidence": "high/medium/low",
  "reason": "一句话理由",
  "alternatives": ["备选技能1", "备选技能2"]  // confidence 非 high 时提供
}
```

</details>

### LLM 调度示例

| 用户说的话 | 硬编码结果 | LLM 理解 |
|-----------|-----------|----------|
| "搞定这个支付流程" | ❌ 无匹配 | ✅ auto-coder (理解"搞定"=实现) |
| "这个登录有点问题，你看看" | ❌ 歧义 | ✅ debugger (理解"看看"=诊断) |
| "弄一下这个页面" | ❌ 无匹配 | ✅ 询问：改样式？还是改逻辑？ |
| "继续刚才的" | ❌ 无上下文 | ✅ 根据对话历史判断 |

---

## 🔒 冲突消解规则

当多个技能可能适用时，按以下规则决策：

### auto-coder vs logic-architect

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "这个功能**怎么设计**" | `logic-architect` | 只要设计咨询 |
| "**帮我设计**用户认证" | `logic-architect` | 重点在"设计" |
| "**帮我实现**用户认证" | `auto-coder` | 重点在"实现" |
| "**设计并实现** X" | `auto-coder` | 有"实现"→写代码 |
| "分析一下这个架构" | `logic-architect` | 分析讨论 |
| "按这个架构**做出来**" | `auto-coder` | 要产出代码 |

> **口诀**: 有"实现/写/做/开发"→ auto-coder；只有"设计/分析/评审"→ logic-architect

### auto-coder vs testing-strategist

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "**怎么测试**这个功能" | `testing-strategist` | 测试策略咨询 |
| "**帮我写**单元测试" | `testing-strategist` | 只写测试，不涉及主逻辑 |
| "**实现并测试**这个功能" | `auto-coder` | 功能+测试，auto-coder 主导 |
| "**实现** X，**然后**写测试" | `auto-coder` | 组合任务，auto-coder 协调 |
| "这个测试**为什么失败**" | `debugger` | 诊断问题 |

> **口诀**: 单独写测试 → testing-strategist；功能+测试 → auto-coder

### auto-coder vs debugger

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "这里**报错了**" | `debugger` | 先诊断问题 |
| "**为什么**不工作" | `debugger` | 分析原因 |
| "**帮我修**这个 bug" | `auto-coder` | 需要写修复代码 |
| "报错了，**帮我改好**" | `auto-coder` | 需要修改代码 |
| "分析一下这个错误" | `debugger` | 只要分析 |

> **口诀**: 诊断/分析 → debugger；修复/改代码 → auto-coder

### auto-coder vs uiux-designer 体系

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "**设计**一个按钮组件的规范" | `uiux-designer` | 设计规范文档 |
| "**实现**一个按钮组件" | `auto-coder` | 写组件代码 |
| "**美化**这个页面" | `ux-patterns` | UI 改进指导 |
| "**重写**这个页面的样式" | `auto-coder` | 需要写 CSS/代码 |
| "这个交互**怎么做**比较好" | `ux-patterns` | 设计建议 |
| "**按这个设计实现**" | `auto-coder` | 执行实现 |
| "做一个 AI 聊天界面" | `ai-components` | AI 专项组件 |
| "设计钱包连接按钮" | `web3-components` | Web3 专项组件 |

> **口诀**: 设计规范/建议 → uiux-designer 体系；写代码实现 → auto-coder

### auto-coder vs tech-lead

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "**检查**代码规范" | `tech-lead` | 审查报告 |
| "**分析**命名是否合理" | `tech-lead` | 规范分析 |
| "**统一**这些命名风格" | `auto-coder` | 需要改代码 |
| "**重构**成符合规范的代码" | `auto-coder` | 需要重写代码 |

> **口诀**: 检查/分析 → tech-lead；修改/重构 → auto-coder

### auto-coder vs auto-writer

| 用户说的话 | 选择 | 理由 |
|-----------|------|------|
| "**帮我写**一篇技术博客" | `auto-writer` | 内容写作 |
| "**帮我写** README" | `docs-writer` | 代码文档 |
| "**帮我写**用户认证代码" | `auto-coder` | 写代码 |
| "**写**一篇小红书文案" | `auto-writer` | 营销写作 |
| "**写**一个登录组件" | `auto-coder` | 组件代码 |
| "写年终总结" | `auto-writer` | 商业写作 |
| "写单元测试" | `auto-coder` / `testing-strategist` | 测试代码 |
| "写学术论文" | `auto-writer` | 学术写作 |
| "写 API 接口代码" | `auto-coder` | 代码实现 |
| "给这个函数写注释" | `auto-coder` | 代码相关 |
| "写产品介绍文案" | `auto-writer` | 营销内容 |

> **口诀**: 写代码 → auto-coder；写文章/文案/报告 → auto-writer；写代码文档 → docs-writer

---

## 输出格式

### 高置信度（直接执行）

```markdown
📌 **已识别意图**: [意图描述]
🎯 **调用技能**: `skill-name`

[直接执行技能内容]
```

### 中置信度（推荐选择）

```markdown
📌 **识别到多个可能的技能**：

| 选项 | 技能 | 适用场景 |
|------|------|----------|
| 1️⃣ | `skill-a` | [场景描述] |
| 2️⃣ | `skill-b` | [场景描述] |

请选择最符合你需求的选项（输入数字）
```

### 低置信度（询问）

```markdown
❓ **需要更多信息**

你的需求可能涉及：
- [可能方向A]
- [可能方向B]

请描述更多细节，或直接告诉我你想要：
- 写文档？使用 `/docs-writer`
- 设计功能？使用 `/product-manager`
- 审查代码？使用 `/project-reviewer`
```

### 组合任务

```markdown
📋 **识别为组合任务**: [任务描述]

**执行计划**：
1. `product-manager` - 定义需求
2. `logic-architect` - 设计架构
3. `api-designer` - 设计接口

当前执行第 1 步...
```

---

## 快速命令

```
# 自动调度（默认行为）
"帮我设计一个用户注册功能"

# 强制询问
"我需要帮助，但不确定用哪个技能"

# 查看所有技能
"列出所有可用技能"

# 技能组合
"从头到尾帮我做一个新功能"
```

---

## 技能目录

完整技能列表和能力说明，见 [skills-catalog.md](skills-catalog.md)
