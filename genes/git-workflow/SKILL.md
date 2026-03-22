---
name: git-workflow
description: Standardize Git workflow with conventional commits, PR templates, branch naming, and changelog generation. Use when committing code, creating PRs, managing releases, or when the user mentions git, commit, pull request, branch, or changelog.
---

# Git Workflow (Git 工作流)

**Goal**: 规范化 Git 操作，确保提交历史清晰、可追溯、自动化友好。

---

## 1. Conventional Commits

### 提交格式

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Type 类型

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | feat(chat): add streaming response |
| `fix` | 修复 Bug | fix(wallet): handle disconnect state |
| `docs` | 文档更新 | docs(readme): update installation |
| `style` | 代码格式 | style: format with prettier |
| `refactor` | 重构 | refactor(api): extract service layer |
| `perf` | 性能优化 | perf(query): add database index |
| `test` | 测试 | test(auth): add unit tests |
| `chore` | 构建/工具 | chore(deps): update dependencies |
| `ci` | CI 配置 | ci: add github actions |

### Scope 范围 (项目特定)

```
AI 项目常用:
- chat, prompt, model, stream, agent

Web3 项目常用:
- wallet, tx, contract, chain, sign

通用:
- api, auth, db, ui, config
```

### Subject 规则

- 使用祈使句 ("add" 而非 "added")
- 首字母小写
- 不加句号
- 限制 50 字符

### 示例

```bash
# 简单
feat(chat): add message history

# 带 body
fix(wallet): handle network switch during transaction

The wallet would crash when user switches network while
a transaction is pending. Now we cancel the pending tx
and show an error message.

# 带 breaking change
feat(api)!: change response format to JSON:API

BREAKING CHANGE: API responses now follow JSON:API spec.
Old format is no longer supported.
```

---

## 2. Branch Naming

### 格式

```
<type>/<ticket>-<description>
```

### 示例

```bash
feat/PROJ-123-add-wallet-connect
fix/PROJ-456-streaming-timeout
refactor/no-ticket-cleanup-hooks
hotfix/critical-security-patch
```

### 分支策略 (Trunk-Based for OPC)

```
main (production)
  ↑
  └── feat/xxx (short-lived feature branches)
  └── fix/xxx
  └── hotfix/xxx (直接合并 main)
```

**OPC 简化原则**:
- 不需要 develop 分支
- Feature 分支尽快合并 (1-3 天)
- Hotfix 直接从 main 创建并合并

---

## 3. Pull Request Template

### 模板 (.github/pull_request_template.md)

```markdown
## Summary
<!-- 一句话描述这个 PR 做了什么 -->

## Changes
<!-- 列出主要变更 -->
- 
- 
- 

## Type
<!-- 选择一个 -->
- [ ] feat: 新功能
- [ ] fix: Bug 修复
- [ ] refactor: 重构
- [ ] docs: 文档
- [ ] test: 测试
- [ ] chore: 其他

## Testing
<!-- 如何验证这些变更 -->
- [ ] 本地测试通过
- [ ] 单元测试通过
- [ ] E2E 测试通过 (如适用)

## Screenshots
<!-- 如有 UI 变更，附截图 -->

## Checklist
- [ ] 代码已自审
- [ ] 无 console.log
- [ ] 类型定义完整
- [ ] 文档已更新 (如需要)
```

### PR 标题规范

遵循 Conventional Commits 格式：

```
feat(chat): add streaming response support
fix(wallet): handle disconnect state
refactor(api): extract service layer
```

---

## 4. Commit Message Templates

### Git 配置

```bash
# 设置提交模板
git config --global commit.template ~/.gitmessage

# ~/.gitmessage
# <type>(<scope>): <subject>
#
# <body>
#
# <footer>
#
# Types: feat, fix, docs, style, refactor, perf, test, chore, ci
# Scope: chat, wallet, api, auth, ui, config, etc.
# Subject: imperative, lowercase, no period, max 50 chars
# Body: explain what and why (not how), wrap at 72 chars
# Footer: BREAKING CHANGE, Closes #issue
```

### 快速提交脚本

```bash
# scripts/commit.sh
#!/bin/bash

types=("feat" "fix" "docs" "style" "refactor" "perf" "test" "chore" "ci")

echo "Select type:"
select type in "${types[@]}"; do
  break
done

read -p "Scope (optional): " scope
read -p "Subject: " subject

if [ -n "$scope" ]; then
  git commit -m "$type($scope): $subject"
else
  git commit -m "$type: $subject"
fi
```

---

## 5. Changelog Generation

### 自动生成 (使用 conventional-changelog)

```bash
# 安装
pnpm add -D conventional-changelog-cli

# 生成
npx conventional-changelog -p angular -i CHANGELOG.md -s
```

### 手动模板

```markdown
# Changelog

## [1.2.0] - 2024-01-15

### Added
- feat(chat): streaming response support
- feat(wallet): multi-chain support

### Fixed
- fix(api): rate limiting edge case
- fix(ui): mobile responsive issues

### Changed
- refactor(auth): simplify token refresh logic

### Security
- security: upgrade vulnerable dependencies
```

---

## 6. Release Workflow

### 版本号规范 (SemVer)

```
MAJOR.MINOR.PATCH

1.0.0 → 1.0.1  (patch: bug fixes)
1.0.0 → 1.1.0  (minor: new features, backward compatible)
1.0.0 → 2.0.0  (major: breaking changes)
```

### 发布流程

```bash
# 1. 确保 main 分支最新
git checkout main && git pull

# 2. 更新版本号
npm version minor  # 或 major/patch

# 3. 生成 changelog
npx conventional-changelog -p angular -i CHANGELOG.md -s

# 4. 提交
git add CHANGELOG.md
git commit --amend --no-edit

# 5. 推送 (包含 tag)
git push && git push --tags

# 6. GitHub 自动发布 (通过 CI)
```

### GitHub Release 模板

```markdown
## What's New

### Features
- ✨ Streaming response support (#123)
- ✨ Multi-chain wallet connection (#124)

### Bug Fixes
- 🐛 Fixed rate limiting edge case (#125)

### Breaking Changes
- ⚠️ API response format changed to JSON:API

## Upgrade Guide

If you're upgrading from v1.x:
1. Update API client to handle new response format
2. ...

## Full Changelog
https://github.com/user/repo/compare/v1.1.0...v1.2.0
```

---

## 7. Git Hooks

### Husky 配置

```bash
# 安装
pnpm add -D husky
pnpm exec husky init
```

### Pre-commit Hook

```bash
# .husky/pre-commit
pnpm lint-staged
```

### Commit-msg Hook (验证格式)

```bash
# .husky/commit-msg
npx --no -- commitlint --edit $1
```

### commitlint 配置

```javascript
// commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', [
      'chat', 'wallet', 'api', 'auth', 'ui', 'config',
      'prompt', 'model', 'tx', 'contract'
    ]],
  },
}
```

### lint-staged 配置

```javascript
// lint-staged.config.js
module.exports = {
  '*.{ts,tsx}': ['eslint --fix', 'prettier --write'],
  '*.{json,md}': ['prettier --write'],
}
```

---

## Quick Reference

### 常用命令

```bash
# 交互式暂存
git add -p

# 修改最后一次提交
git commit --amend

# 压缩多个提交
git rebase -i HEAD~3

# 查看美化日志
git log --oneline --graph

# 临时保存
git stash
git stash pop
```

### Commit Message 速查

```
feat:     新功能
fix:      修复
docs:     文档
style:    格式
refactor: 重构
perf:     性能
test:     测试
chore:    杂项
ci:       CI/CD
```

### 分支命令

```bash
# 创建并切换
git checkout -b feat/new-feature

# 删除本地分支
git branch -d feat/merged-branch

# 删除远程分支
git push origin --delete feat/old-branch
```
