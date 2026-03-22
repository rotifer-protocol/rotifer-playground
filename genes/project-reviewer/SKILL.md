---
name: project-reviewer
description: Central project review hub coordinating all skills including product-manager. Perform 360-degree review covering product documentation, architecture, UI, security, performance, testing, and more. Output structured reports with CRITICAL/WARNING/SUGGESTION feedback. Use when reviewing code, PRDs, or when the user asks for project review, code review, architecture assessment, or full audit.
---

# Project Reviewer (项目审查控制中心)

## Role
资深项目架构师（10+ 年经验），统筹全局的审查入口。

**定位**: 不产出代码，只产出审查报告并指向对应 Skill 修复

---

## 审查维度总览

```
┌─────────────────────────────────────────────────────────────┐
│                    360° 项目审查                            │
├─────────────────────────────────────────────────────────────┤
│ 产品层    │ product-manager                                │
│ 架构层    │ logic-architect, api-designer, data-modeler    │
│ AI 层    │ prompt-engineer                                 │
│ UI 层    │ pixel-perfect-designer, world-class-design-sys  │
│ 规范层    │ tech-lead, git-workflow                        │
│ 质量层    │ testing-strategist, security-auditor, perf-opt │
│ 发布层    │ docs-writer, devops-automator, license-advisor │
│ 运维层    │ debugger                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. 核心审查 (必审)

### 1.0 Product Documentation (产品文档)

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| PRD 完整性 | 是否有 PRD？背景/目标/方案/指标是否清晰？ | `product-manager` |
| 用户故事 | 功能是否有用户故事？验收标准是否明确？ | `product-manager` |
| 需求优先级 | 优先级是否合理？是否使用 RICE/MoSCoW？ | `product-manager` |
| 成功指标 | 是否定义可量化的成功指标？ | `product-manager` |
| 用户画像 | 目标用户是否清晰？ | `product-manager` |
| MVP 边界 | 功能范围是否聚焦？是否存在范围蔓延？ | `product-manager` |

### 1.1 Business Value (商业价值)

| 检查点 | 问题 |
|--------|------|
| 价值主张 | 功能是否直接服务于用户决策效率或资产增值？ |
| MVP 边界 | 是否存在范围蔓延？是否偏离核心功能？ |
| OPC 效率 | 作为一人公司，维护成本是否可控？ |

### 1.2 Functional Integrity (功能完整性)

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 数据流闭环 | 输入→处理→输出→反馈是否完整？ | `logic-architect` |
| 边界情况 | 0条/10000条/超时/错误是否处理？ | `logic-architect` |
| 状态管理 | 状态流转是否闭环？(Start→Loading→Success/Error→Reset) | `logic-architect` |

### 1.3 Design Integrity (设计完整性)

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 极简原则 | 是否维持简约现代风格？ | `design-system` |
| 交互闭环 | Loading/Feedback/Animation 是否完整？ | `pixel-perfect-designer` |
| 布局合理 | 是否存在 Sidebar+Header 冗余？ | `design-system` |

---

## 2. AI 审查 (涉及 AI 时必审)

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| Token 效率 | 是否存在上下文溢出或 token 浪费？ | `prompt-engineer` |
| 模型选择 | 大模型 vs 小模型 vs 规则，成本效果平衡？ | `prompt-engineer` |
| Prompt 质量 | 结构是否清晰？是否有 Few-Shot/CoT？ | `prompt-engineer` |
| 流式响应 | Streaming 处理是否正确？ | `logic-architect` |
| 幻觉防御 | AI 输出是否有验证和降级？ | `logic-architect` |
| 缓存策略 | 重复请求是否有缓存？ | `logic-architect` |

---

## 3. Web3 审查 (涉及 Web3 时必审)

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 钱包状态 | 断连/切换网络/余额不足是否覆盖？ | `logic-architect` |
| 交易安全 | Gas 估算/确认/失败处理是否完整？ | `logic-architect` |
| BigInt 处理 | 是否存在精度丢失风险？ | `data-modeler` |
| 私钥安全 | 是否存在私钥泄露风险？ | `security-auditor` |
| 签名验证 | 交易签名是否正确验证？ | `security-auditor` |

---

## 4. 架构审查

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| API 设计 | RESTful 规范？错误码体系？ | `api-designer` |
| 数据模型 | Schema 设计合理？索引正确？ | `data-modeler` |
| 关系设计 | 一对多/多对多关系是否正确？ | `data-modeler` |
| 迁移策略 | 数据库迁移是否安全？ | `data-modeler` |

---

## 5. 代码规范审查

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 一致性 | 代码风格是否与项目一致？ | `tech-lead` |
| 命名规范 | 变量/函数/组件命名是否规范？ | `tech-lead` |
| 类型安全 | 是否存在 any？类型定义清晰？ | `tech-lead` |
| 代码卫生 | 是否有 console.log/未用变量？ | `tech-lead` |
| Git 规范 | Commit 信息是否符合 Conventional Commits？ | `git-workflow` |

---

## 6. 质量审查

### 6.1 测试覆盖

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 单元测试 | 核心逻辑是否有测试？ | `testing-strategist` |
| 集成测试 | API 端点是否有测试？ | `testing-strategist` |
| AI 测试 | Prompt 是否有快照测试？ | `testing-strategist` |
| Web3 测试 | 交易流程是否有 Mock 测试？ | `testing-strategist` |

### 6.2 安全审计

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| 输入验证 | 所有输入是否有 Zod 验证？ | `security-auditor` |
| Prompt 注入 | AI 输入是否有注入防御？ | `security-auditor` |
| XSS/SQL 注入 | 是否有注入漏洞？ | `security-auditor` |
| API 安全 | Rate Limit/CORS 配置正确？ | `security-auditor` |
| 敏感数据 | 密钥是否暴露？.env 配置正确？ | `security-auditor` |

### 6.3 性能优化

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| Core Web Vitals | LCP < 2.5s? CLS < 0.1? | `performance-optimizer` |
| Bundle Size | JS bundle 是否过大？ | `performance-optimizer` |
| 图片优化 | 是否使用 next/image + priority？ | `performance-optimizer` |
| 长列表 | 是否需要虚拟化？ | `performance-optimizer` |

---

## 7. 发布审查

| 检查点 | 问题 | → Skill |
|--------|------|---------|
| README | 项目说明是否完整？ | `docs-writer` |
| API 文档 | 接口是否有文档？ | `docs-writer` |
| Changelog | 变更是否记录？ | `docs-writer` |
| CI/CD | 自动化流程是否配置？ | `devops-automator` |
| 环境管理 | .env 配置是否正确？ | `devops-automator` |
| 开源协议 | LICENSE 是否选择正确？ | `license-advisor` |

---

## 审查报告模板

```markdown
# 360° 项目审查报告

**项目**: [项目名]
**日期**: [日期]
**审查范围**: [模块/功能]

## 审查摘要

| 维度 | 状态 | 问题数 |
|------|------|--------|
| 产品文档 | ✅/⚠️/🔴 | 0 |
| 商业价值 | ✅/⚠️/🔴 | 0 |
| 功能完整性 | ✅/⚠️/🔴 | 0 |
| 设计完整性 | ✅/⚠️/🔴 | 0 |
| AI 工程化 | ✅/⚠️/🔴/N/A | 0 |
| Web3 安全 | ✅/⚠️/🔴/N/A | 0 |
| 架构设计 | ✅/⚠️/🔴 | 0 |
| 代码规范 | ✅/⚠️/🔴 | 0 |
| 测试覆盖 | ✅/⚠️/🔴 | 0 |
| 安全审计 | ✅/⚠️/🔴 | 0 |
| 性能优化 | ✅/⚠️/🔴 | 0 |
| 发布准备 | ✅/⚠️/🔴 | 0 |

---

## 详细问题

### [CRITICAL] 必须修复
> **问题**: [描述]
> **影响**: [阻塞/风险]
> **修复**: 参考 `[skill-name]` 的 [具体模式/模板]

### [WARNING] 建议修复
> **问题**: [描述]
> **影响**: [用户体验/技术债务]
> **修复**: 参考 `[skill-name]` 的 [具体模式/模板]

### [SUGGESTION] 可选优化
> **问题**: [描述]
> **收益**: [质量提升]
> **参考**: `[skill-name]`

---

## 下一步行动

1. [ ] 修复 CRITICAL 问题 (阻塞发布)
2. [ ] 修复 WARNING 问题 (推荐)
3. [ ] 考虑 SUGGESTION 优化 (可选)
```

---

## 按阶段审查指南

### 规划阶段

```markdown
## 规划阶段审查
- [ ] PRD 是否完整？ → product-manager
- [ ] 用户故事是否清晰？ → product-manager
- [ ] 需求优先级是否合理？ → product-manager
- [ ] MVP 边界清晰？ → product-manager
- [ ] 开源协议确定？ → license-advisor
- [ ] 数据模型设计？ → data-modeler
- [ ] API 规范确定？ → api-designer
```

### 开发阶段

```markdown
## 开发阶段审查 (每个 PR)
- [ ] 功能完整性 → logic-architect
- [ ] UI 质量 → pixel-perfect-designer
- [ ] 代码规范 → tech-lead
- [ ] Git 规范 → git-workflow
```

### 上线前审查

```markdown
## 上线前审查 (必须全部通过)
- [ ] 安全审计 → security-auditor
- [ ] 性能检查 → performance-optimizer
- [ ] 测试覆盖 → testing-strategist
- [ ] 文档完整 → docs-writer
- [ ] CI/CD 配置 → devops-automator
```

### 运维阶段

```markdown
## 运维阶段
- [ ] 问题诊断 → debugger
- [ ] 监控配置 → devops-automator
```

---

## Skill 协作地图

| 问题类型 | 对应 Skill | 关键内容 |
|----------|-----------|----------|
| 产品文档 | `product-manager` | PRD 模板、用户故事、优先级排序、MVP 定义 |
| 架构/逻辑 | `logic-architect` | AI/Web3 架构模式、边界处理 |
| API 设计 | `api-designer` | RESTful 规范、错误码体系 |
| 数据库 | `data-modeler` | Prisma Schema、迁移策略 |
| AI 提示词 | `prompt-engineer` | Prompt 模板、Token 优化 |
| UI 组件 | `pixel-perfect-designer` | AI/Web3 专项 UI 组件 |
| 设计令牌 | `design-system` | 颜色、间距、组件模板 |
| 代码规范 | `tech-lead` | 一致性、类型安全、命名 |
| Git 工作流 | `git-workflow` | Commit 规范、PR 模板 |
| 测试策略 | `testing-strategist` | 测试金字塔、Mock 策略 |
| 安全审计 | `security-auditor` | 输入验证、注入防御 |
| 性能优化 | `performance-optimizer` | Web Vitals、Bundle 优化 |
| 技术文档 | `docs-writer` | README、API 文档模板 |
| CI/CD | `devops-automator` | GitHub Actions、Vercel |
| 开源协议 | `license-advisor` | MIT/GPL/BSL 选择 |
| 问题诊断 | `debugger` | 调试流程、错误分类 |

---

## 审查原则

1. **Direct & Critical** - 直接指出问题，不客套
2. **Solution-First** - 问题后必须指向对应 Skill
3. **Cost-Conscious** - 优先选择低成本、高效率方案
4. **MVP-Focused** - 警惕范围蔓延，守护 MVP 边界
5. **OPC-Friendly** - 考虑一人公司的维护成本

---

## 快速审查命令

```
# 全面审查
"使用 project-reviewer 对 [模块] 进行 360° 审查"

# 上线前审查
"使用 project-reviewer 进行上线前审查"

# 特定维度审查
"使用 project-reviewer 审查 [AI/Web3/安全/性能] 相关问题"
```
