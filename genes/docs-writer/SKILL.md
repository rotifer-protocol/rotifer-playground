---
name: docs-writer
description: Write technical documentation including README, API docs, and changelogs. Create clear, structured documentation for AI and Web3 projects. Use when writing documentation, creating README, or when the user mentions docs, documentation, readme, or api docs.
---

# Docs Writer (文档撰写师)

**Goal**: 撰写清晰、实用、易维护的技术文档。

**原则**: 文档是写给未来的自己和他人看的。

---

## 1. README Template

### 项目 README

```markdown
# Project Name

一句话描述项目做什么。

## Features

- ✨ Feature 1
- 🚀 Feature 2
- 🔒 Feature 3

## Quick Start

\`\`\`bash
# Clone
git clone https://github.com/user/repo.git
cd repo

# Install
pnpm install

# Setup environment
cp .env.example .env
# Edit .env with your values

# Run
pnpm dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000)

## Tech Stack

- **Framework**: Next.js 14
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL + Prisma
- **AI**: OpenAI API
- **Web3**: wagmi + viem

## Project Structure

\`\`\`
src/
├── app/          # Next.js app router
├── components/   # React components
├── hooks/        # Custom hooks
├── lib/          # Utilities
└── types/        # TypeScript types
\`\`\`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain ID | No |

## Development

\`\`\`bash
# Run dev server
pnpm dev

# Run tests
pnpm test

# Build
pnpm build
\`\`\`

## License

MIT
```

---

## 2. API Documentation

### Endpoint 文档模板

```markdown
## Create User

Creates a new user account.

### Request

\`\`\`
POST /api/users
\`\`\`

#### Headers

| Header | Value | Required |
|--------|-------|----------|
| Content-Type | application/json | Yes |
| Authorization | Bearer {token} | Yes |

#### Body

\`\`\`json
{
  "name": "张三",
  "email": "zhang@example.com",
  "password": "securepassword"
}
\`\`\`

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| name | string | User display name | Yes |
| email | string | User email address | Yes |
| password | string | Password (min 8 chars) | Yes |

### Response

#### Success (201)

\`\`\`json
{
  "id": "clx1234567",
  "name": "张三",
  "email": "zhang@example.com",
  "createdAt": "2024-01-15T10:30:00Z"
}
\`\`\`

#### Errors

| Code | Description |
|------|-------------|
| 400 | Invalid request body |
| 409 | Email already exists |
| 422 | Validation failed |

### Example

\`\`\`bash
curl -X POST https://api.example.com/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{"name": "张三", "email": "zhang@example.com", "password": "secure123"}'
\`\`\`
```

### API 概览

```markdown
# API Reference

Base URL: `https://api.example.com`

## Authentication

All endpoints require Bearer token authentication.

\`\`\`
Authorization: Bearer {your-api-key}
\`\`\`

## Endpoints

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/users | List users |
| GET | /api/users/:id | Get user |
| POST | /api/users | Create user |
| PATCH | /api/users/:id | Update user |
| DELETE | /api/users/:id | Delete user |

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/chat | Send message |
| GET | /api/chat/history | Get history |

## Error Codes

| Code | Message |
|------|---------|
| 1001 | Authentication required |
| 3001 | Resource not found |
| 4001 | Validation failed |
| 5001 | Rate limited |
```

---

## 3. Changelog

### CHANGELOG.md 模板

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- New feature in progress

## [1.2.0] - 2024-01-15

### Added
- Streaming response support for chat
- Multi-chain wallet connection
- Token usage tracking

### Changed
- Improved error messages
- Updated dependencies

### Fixed
- Rate limiting edge case
- Mobile responsive issues

### Security
- Upgraded vulnerable dependencies

## [1.1.0] - 2024-01-01

### Added
- Initial chat functionality
- Wallet connection

[Unreleased]: https://github.com/user/repo/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/user/repo/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/user/repo/releases/tag/v1.1.0
```

---

## 4. Component Documentation

### 组件文档模板

```markdown
# Button

Primary action button with multiple variants.

## Usage

\`\`\`tsx
import { Button } from '@/components/ui/button'

<Button variant="primary" size="md">
  Click me
</Button>
\`\`\`

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | 'primary' \| 'secondary' \| 'ghost' | 'primary' | Visual style |
| size | 'sm' \| 'md' \| 'lg' | 'md' | Button size |
| disabled | boolean | false | Disable button |
| loading | boolean | false | Show loading spinner |
| onClick | () => void | - | Click handler |

## Variants

### Primary
For main actions.

\`\`\`tsx
<Button variant="primary">Save</Button>
\`\`\`

### Secondary
For secondary actions.

\`\`\`tsx
<Button variant="secondary">Cancel</Button>
\`\`\`

### Ghost
For subtle actions.

\`\`\`tsx
<Button variant="ghost">Learn more</Button>
\`\`\`

## Accessibility

- Uses native `<button>` element
- Supports keyboard navigation
- Includes focus ring
- Disabled state is properly announced
```

---

## 5. .env.example

### 环境变量示例

```bash
# .env.example

# ===================
# Required
# ===================

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/mydb"

# AI
OPENAI_API_KEY="sk-..."

# ===================
# Optional
# ===================

# AI Settings
AI_MODEL="gpt-4o"
AI_MAX_TOKENS="4096"

# Web3
NEXT_PUBLIC_CHAIN_ID="1"
NEXT_PUBLIC_ALCHEMY_KEY="..."

# Feature Flags
ENABLE_STREAMING="true"
```

---

## 6. Contributing Guide

### CONTRIBUTING.md

```markdown
# Contributing

Thanks for your interest in contributing!

## Development Setup

1. Fork the repo
2. Clone your fork
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feat/my-feature`

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/).

\`\`\`
feat(scope): add new feature
fix(scope): fix bug
docs(scope): update documentation
\`\`\`

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure all tests pass: `pnpm test`
4. Create PR with clear description

## Code Style

- Use TypeScript
- Follow existing patterns
- Run `pnpm lint` before committing

## Questions?

Open an issue or start a discussion.
```

---

## 7. Inline Documentation

### JSDoc 注释

```typescript
/**
 * Truncates an Ethereum address for display.
 * 
 * @param address - The full Ethereum address
 * @param chars - Number of characters to show on each end (default: 4)
 * @returns Truncated address (e.g., "0x1234...5678")
 * 
 * @example
 * ```ts
 * truncateAddress("0x1234567890abcdef1234567890abcdef12345678")
 * // => "0x1234...5678"
 * ```
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}
```

### Type 注释

```typescript
/**
 * AI chat message
 */
interface Message {
  /** Unique message ID */
  id: string
  /** Message author role */
  role: 'user' | 'assistant' | 'system'
  /** Message content */
  content: string
  /** Creation timestamp */
  createdAt: Date
}
```

---

## 8. Documentation Checklist

```markdown
## 文档检查清单

### README
- [ ] 一句话描述项目
- [ ] 快速开始步骤
- [ ] 环境变量说明
- [ ] 技术栈列表
- [ ] 项目结构

### API 文档
- [ ] 所有端点列出
- [ ] 请求/响应示例
- [ ] 错误码说明
- [ ] 认证方式

### 代码注释
- [ ] 公共函数有 JSDoc
- [ ] 复杂逻辑有解释
- [ ] TODO 有 issue 链接

### 其他
- [ ] CHANGELOG 更新
- [ ] .env.example 同步
- [ ] CONTRIBUTING 指南
```

---

## Quick Reference

### 文档优先级

```
1. README (必须)
2. .env.example (必须)
3. API 文档 (有 API 时)
4. CHANGELOG (发布时)
5. 组件文档 (有 UI 库时)
```

### 文档工具

```
Mintlify, Docusaurus, Fumadocs, Swagger
```
