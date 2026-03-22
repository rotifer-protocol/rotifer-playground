---
name: auto-coder
description: Execute continuous AI-powered code generation with intelligent iteration loops. Always runs in iterative mode - generates code, validates with quality skills (testing-strategist, tech-lead, logic-architect, debugger), and repeats until success or limits reached. Use when user wants to implement features, write code, or automate programming tasks.
---

# Auto Coder (智能持续编程)

**Goal**: 执行持续迭代的 AI 代码生成，通过智能循环和自动质量验证，实现自动化编程。

**定位**: 执行引擎层，调用其他质量保证技能进行验证。

**Phase 概览**:
- **Phase 1-2**: 纯文档技能（工作流程指导）
- **Phase 3**: 多任务/自适应/学习 → [详情](phases/PHASE-3.md)
- **Phase 4-6**: 深度理解/创造思维/自主规划 → [详情](phases/PHASE-4-6.md)
- **Phase 7-10**: 元学习/多模态/协作/高级自主 → [详情](phases/PHASE-7-10.md)
- **AGI 路径**: 40% → 60% → 80% → 90% → **100%** 🎯

---

## 使用方式

直接对 AI 说：

```
"使用 auto-coder 实现用户认证功能"
"用 auto-coder 分析这个项目的架构"
"auto-coder 帮我找出代码中的问题"
"使用 auto-coder 重构这个模块"
```

AI 将自动：
1. 分析任务类型和复杂度
2. 选择合适的 Phase 能力组合
3. 执行并迭代直到完成
4. 生成报告（可选）

> **注意**: 用户无需了解内部实现细节，AI 会自动选择最佳执行策略。

---

## AI 执行指南

> **本节供 AI 阅读**：当用户调用 auto-coder 时，按以下决策树自动选择能力。

### 能力选择决策树

```
用户请求
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. 任务类型判断                                              │
├─────────────────────────────────────────────────────────────┤
│ • 实现功能 → 使用 Core Workflow (迭代循环)                   │
│ • 分析/理解代码 → Phase 4 深度理解                          │
│ • 解决问题/找方案 → Phase 5 创造性思维                      │
│ • 扫描/审计代码 → Phase 6 自主规划                          │
│ • 学习项目风格 → Phase 7 元学习                             │
│ • 生成图表/文档 → Phase 8 多模态                            │
│ • 复杂多步骤任务 → Phase 9 协作智能                         │
│ • 战略规划/长期记忆 → Phase 10 高级自主                     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. 复杂度评估                                                │
├─────────────────────────────────────────────────────────────┤
│ • Simple: 单文件、单功能 → 快速迭代                          │
│ • Medium: 多文件、需测试 → 标准流程                          │
│ • Complex: 系统级、重构 → 深度分析 + 多 Phase 组合           │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 自动执行                                                  │
├─────────────────────────────────────────────────────────────┤
│ • 无需用户手动调用脚本                                       │
│ • AI 根据需要组合多个 Phase 能力                             │
│ • 迭代直到满足成功标准或达到限制                             │
└─────────────────────────────────────────────────────────────┘
```

### Phase 能力速查

| Phase | 核心能力 | 触发场景 |
|-------|----------|----------|
| **3** | 多任务并行、自适应策略、模式学习 | 多个任务、复杂任务、重复性任务 |
| **4** | 语义理解、知识图谱、根因分析 | 理解代码、诊断问题、分析架构 |
| **5** | 多方案生成、跨领域迁移、实验探索 | 寻找解决方案、优化设计、创新 |
| **6** | 主动扫描、目标规划、自主决策 | 代码审计、技术债务、架构决策 |
| **7** | 学习追踪、策略优化、风格学习 | 适应项目风格、优化执行策略 |
| **8** | 设计分析、图表生成、文档同步 | 生成架构图、同步文档、分析设计 |
| **9** | Agent 编排、任务分发、冲突解决 | 复杂多步骤任务、需要多种专业能力 |
| **10** | 战略规划、创新引擎、项目记忆 | 长期规划、跨会话记忆、持续改进 |

### 自适应复杂度评估

AI 自动评估任务复杂度并调整迭代策略（由 Skill Planner 动态规划）：

| 复杂度 | 识别特征 | 迭代次数 | 验证强度 | 调用技能 |
|--------|----------|---------|---------|---------|
| **Simple** | 单文件、单函数、明确需求 | 3-5 次 | 基础 | testing-strategist, tech-lead |
| **Medium** | 多文件、需测试、有依赖 | 5-10 次 | 标准 | + security-auditor(条件), logic-architect(条件) |
| **Complex** | 系统级、重构、架构变更 | 10-15 次 | 全面 | + logic-architect, security-auditor, 按需(设计技能) |

**安全敏感任务**（无论复杂度，强制调用 security-auditor）：
- AI 任务：prompt, llm, openai, anthropic
- Web3 任务：wallet, contract, sign, transaction
- Auth 任务：login, password, token, jwt

**复杂度关键词识别**：
- Simple: "添加"、"修改"、"简单"
- Medium: "实现"、"功能"、"测试"
- Complex: "重构"、"系统"、"架构"、"全面"、"整个"

---

## Core Workflow

```
初始化 → 迭代循环 → 质量验证 → 反馈更新 → 继续/停止
   ↓         ↓          ↓          ↓          ↓
读取任务  生成代码   调用技能    更新提示    检查条件
```

> **详细说明**: [reference/CORE-WORKFLOW.md](reference/CORE-WORKFLOW.md)

### 质量验证循环（摘要）

| 步骤 | 技能 | 触发条件 |
|------|------|----------|
| 3.1 Testing | testing-strategist | [核心] 每次迭代 |
| 3.2 Code Standards | tech-lead | [核心] 每次迭代 |
| 3.3 Architecture | logic-architect | [条件] 复杂任务/架构变更 |
| 3.4 Security | security-auditor | [条件] 安全敏感代码 |
| 3.5 Error Handling | debugger | [出错时] |

### 停止条件

| 类型 | 条件 |
|------|------|
| ✅ 成功 | 所有验证通过 |
| ❌ 失败 | 连续失败 3 次 / 达到最大迭代 / 超时 |
| ⏸️ 中断 | 用户明确要求停止 |

---

## Skill Dependencies

### 核心技能（每次迭代必调用）

| 技能 | 说明 |
|------|------|
| `testing-strategist` | 测试策略与执行 |
| `tech-lead` | 代码规范检查 |

### 条件技能（根据任务特征触发）

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `logic-architect` | 架构变更时 | 架构评估、建议 |
| `security-auditor` | 安全敏感代码时 | 安全问题、修复建议 |
| `prompt-engineer` | AI 组件时 | Prompt 优化 |
| `performance-optimizer` | 性能敏感时 | 性能问题、优化建议 |
| `debugger` | 出现错误时 | 根因分析、修复方案 |

### 设计技能（复杂任务时触发）

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `api-designer` | API 变更时 | API 设计建议 |
| `data-modeler` | 数据库变更时 | 数据模型建议 |
| `uiux-designer` | UI 变更时 | 设计规范（统一调度 5 个子技能）|

### 工程实践技能

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `devops-automator` | 部署/DevOps 变更时 | CI/CD、Docker、部署配置 |
| `git-workflow` | Git 工作流相关时 | Git 规范与工作流 |
| `license-advisor` | 新建项目时 | 开源许可证建议 |

### 文档技能

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `docs-writer` | 文档需求时 | 技术文档生成 |
| `doc-coauthoring` | 规格文档时 | 文档协作流程 |

### 需求与特殊领域技能

| 技能 | 调用时机 | 说明 |
|------|----------|------|
| `product-manager` | 需求分析时 | 需求分析辅助 |
| `algorithmic-art` | 生成艺术项目时 | 算法艺术生成 |
| `project-reviewer` | 复杂任务完成后 | 360度项目评审 |

> **说明**：核心技能每次迭代必调用，其他技能由 Skill Planner 根据任务分析结果动态决定。

---

## Skill Planning (智能技能规划)

```
用户任务 → Task Analyzer → Skill Planner → 动态验证循环
              │                │
              ▼                ▼
         TaskAnalysis      SkillPlan
```

### Task Analyzer 输出

```typescript
interface TaskAnalysis {
  taskType: 'frontend' | 'backend' | 'fullstack' | 'ai' | 'web3' | 'mixed'
  domains: string[]           // ['auth', 'payment', 'ai', ...]
  complexity: 'simple' | 'medium' | 'complex'
  securitySensitive: boolean
  performanceCritical: boolean
  // 原有领域
  hasUIChanges: boolean
  hasAPIChanges: boolean
  hasDBChanges: boolean
  hasAIComponents: boolean
  hasWeb3Components: boolean
  hasAuthComponents: boolean
  // 新增领域
  hasDeploymentChanges: boolean   // → devops-automator
  hasDocumentationNeeds: boolean  // → docs-writer
  hasGitWorkflow: boolean         // → git-workflow
  hasLicenseNeeds: boolean        // → license-advisor
  hasRequirementsAnalysis: boolean // → product-manager
  hasGenerativeArt: boolean       // → algorithmic-art
  isNewProject: boolean           // → license-advisor
  needsFinalReview: boolean       // → project-reviewer (任务完成时设置)
}
```

### Skill Planner 规则

| 条件 | 调用的 Skill |
|------|-------------|
| 所有任务 | testing-strategist, tech-lead [核心] |
| securitySensitive = true | + security-auditor |
| hasAIComponents = true | + prompt-engineer, + security-auditor |
| hasWeb3Components = true | + security-auditor (强制) |
| complexity = complex | + logic-architect |
| performanceCritical = true | + performance-optimizer |
| hasAPIChanges = true | + api-designer |
| hasDBChanges = true | + data-modeler |
| hasUIChanges = true | + uiux-designer（自动调度子技能）|
| hasDeploymentChanges = true | + devops-automator |
| hasDocumentationNeeds = true | + docs-writer |
| hasGitWorkflow = true | + git-workflow |
| isNewProject = true | + license-advisor |
| hasRequirementsAnalysis = true | + product-manager, + doc-coauthoring |
| hasGenerativeArt = true | + algorithmic-art |
| complexity = complex AND 任务完成 | + project-reviewer |
| 出错时 | + debugger |

---

## Usage Examples

### Example 1: Simple Feature

```markdown
用户: "使用 auto-coder 实现用户登录功能"

流程:
1. 创建 .auto-coder/PROMPT.md: "实现用户登录功能"
2. 迭代 1: 生成基础登录代码 → 测试失败（缺少错误处理）
3. 迭代 2: 添加错误处理 → 规范警告（命名不一致）
4. 迭代 3: 统一命名 → ✅ 全部通过
5. 归档到 docs/auto-coder/prompts/，清空工作区
```

### Example 2: Complex Refactoring

```markdown
用户: "使用 auto-coder 重构认证模块"

流程:
1. 读取现有代码
2. 分析架构问题（调用 logic-architect）
3. 生成重构方案
4. 逐步迭代改进
5. 每次迭代验证不破坏现有功能
```

---

## Best Practices

### DO ✅

- ✅ 每次迭代后立即验证
- ✅ 记录所有错误和修复尝试
- ✅ 更新 .auto-coder/PROMPT.md 避免重复错误
- ✅ 设置合理的停止条件
- ✅ 调用相关技能进行质量验证

### DON'T ❌

- ❌ 无限循环无停止条件
- ❌ 忽略测试失败继续迭代
- ❌ 不记录错误历史
- ❌ 跳过质量验证步骤
- ❌ 重复尝试相同的失败方案

---

## Quick Reference

### Checklist

```markdown
## Auto-Coding Checklist

### Before Starting
- [ ] 任务目标明确
- [ ] .auto-coder/PROMPT.md 已创建/更新
- [ ] 成功标准已定义
- [ ] 迭代限制已设置

### During Iteration
- [ ] 生成代码
- [ ] 运行测试 (testing-strategist)
- [ ] 检查规范 (tech-lead)
- [ ] 验证架构 (logic-architect)
- [ ] 处理错误 (debugger)
- [ ] 更新 .auto-coder/PROMPT.md

### After Completion
- [ ] 生成最终报告
- [ ] 清理临时文件
- [ ] 记录经验教训
```

### Common Commands

```bash
# 启动 auto-coder
"使用 auto-coder 实现 [功能]"

# 带限制的启动
"使用 auto-coder 实现 [功能]，最多 5 次迭代"

# 继续之前的任务
"继续 auto-coder 任务，从归档恢复"
```

---

## Troubleshooting

| 问题 | 解决方案 |
|------|----------|
| 无限循环 | 检查停止条件，确保有最大迭代限制 |
| 重复错误 | 检查 .auto-coder/PROMPT.md 是否更新，确保记录错误历史 |
| 测试一直失败 | 调用 debugger 深入分析，可能需要调整任务范围 |
| Token 超限 | 减少每次迭代的代码量，或增加预算 |
| 质量验证失败 | 分别调用对应技能，获取详细反馈 |

---

## Integration with orch

在 `orch` 中注册：

```markdown
### 持续编程场景

| 关键词/意图 | 技能 | 示例 |
|-------------|------|------|
| 自动编程、持续迭代、一键完成 | `auto-coder` | "帮我自动实现这个功能" |
| 自动编程 + 测试 | `auto-coder` | "自动实现并测试" |
```

---

## Additional Resources

### 参考文档

| 文档 | 描述 |
|------|------|
| [reference/CORE-WORKFLOW.md](reference/CORE-WORKFLOW.md) | 完整工作流程细节 |
| [reference/CLI-REFERENCE.md](reference/CLI-REFERENCE.md) | CLI 命令参考（高级用户） |
| [phases/PHASE-3.md](phases/PHASE-3.md) | Phase 3: 多任务/自适应/学习 |
| [phases/PHASE-4-6.md](phases/PHASE-4-6.md) | Phase 4-6: 深度理解/创造/自主 |
| [phases/PHASE-7-10.md](phases/PHASE-7-10.md) | Phase 7-10: 高级 AGI 能力 |

### 模板和配置

| 文件 | 描述 |
|------|------|
| [templates/PROMPT.md.template](templates/PROMPT.md.template) | PROMPT 模板 |
| [templates/config.json](templates/config.json) | 配置示例 |
| [templates/SYSTEM-ARCHITECTURE.md](templates/SYSTEM-ARCHITECTURE.md) | 系统架构设计 |
| [templates/AGI-ANALYSIS.md](templates/AGI-ANALYSIS.md) | AGI 路径分析 |
| [templates/ROADMAP-40-to-90.md](templates/ROADMAP-40-to-90.md) | AGI 路线图 |
