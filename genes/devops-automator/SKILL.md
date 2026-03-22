---
name: devops-automator
description: Automate CI/CD pipelines, Docker configuration, and deployment for Next.js AI/Web3 apps. Setup GitHub Actions, Vercel, and environment management. Use when setting up deployment, CI/CD, or when the user mentions deploy, docker, github actions, vercel, or ci/cd.
---

# DevOps Automator (自动化运维师)

**Goal**: 自动化构建、测试、部署流程，降低 OPC 运维负担。

**原则**: 能自动化的不手动，能托管的不自建。

---

## 1. GitHub Actions

### 基础 CI 流程

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm test

  build:
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm build
```

### 带数据库的测试

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      
      - run: pnpm install
      
      - name: Setup Database
        run: pnpm prisma db push
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
      
      - name: Run Tests
        run: pnpm test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
```

### 自动发布

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Generate Changelog
        id: changelog
        uses: metcalfc/changelog-generator@v4
        with:
          myToken: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          body: ${{ steps.changelog.outputs.changelog }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 2. Vercel Deployment

### vercel.json 配置

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install",
  "regions": ["hkg1"],
  "env": {
    "DATABASE_URL": "@database-url",
    "OPENAI_API_KEY": "@openai-api-key"
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "no-store" }
      ]
    }
  ]
}
```

### 环境变量设置

```bash
# 使用 Vercel CLI
vercel env add DATABASE_URL production
vercel env add OPENAI_API_KEY production

# 或在 Vercel Dashboard 设置
# Settings → Environment Variables
```

### 预览部署

```yaml
# PR 自动预览 (Vercel 默认支持)
# 每个 PR 都会有独立预览 URL
```

---

## 3. Docker

### Next.js Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Builder
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Runner
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
```

### next.config.js (Standalone)

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
}

module.exports = nextConfig
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/app
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - db

  db:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=app

volumes:
  postgres_data:
```

---

## 4. Environment Management

### .env 文件结构

```bash
# .env.local (本地开发，不提交)
DATABASE_URL="postgresql://..."
OPENAI_API_KEY="sk-..."

# .env.development (开发环境默认值，可提交)
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_CHAIN_ID="11155111"

# .env.production (生产环境默认值，可提交)
NEXT_PUBLIC_APP_URL="https://myapp.com"
NEXT_PUBLIC_CHAIN_ID="1"

# .env.example (示例，必须提交)
DATABASE_URL="postgresql://user:password@localhost:5432/db"
OPENAI_API_KEY="sk-..."
```

### 环境变量验证

```typescript
// lib/env.ts
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_CHAIN_ID: z.string().optional().default('1'),
})

export const env = envSchema.parse(process.env)
```

---

## 5. Database Management

### Prisma Migrate in CI

```yaml
# 在部署前运行 migration
- name: Run Migrations
  run: pnpm prisma migrate deploy
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

### 数据库备份 (Cron Job)

```yaml
# .github/workflows/backup.yml
name: Database Backup

on:
  schedule:
    - cron: '0 0 * * *'  # 每天 UTC 00:00

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Backup Database
        run: |
          pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
      
      - name: Upload to S3
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ap-northeast-1
      - run: aws s3 cp backup-*.sql s3://my-backups/
```

---

## 6. Monitoring & Alerts

### Uptime Monitoring

```yaml
# 使用 Better Uptime / UptimeRobot
# 或自建 GitHub Actions 检查

name: Health Check

on:
  schedule:
    - cron: '*/5 * * * *'  # 每 5 分钟

jobs:
  health:
    runs-on: ubuntu-latest
    steps:
      - name: Check Health
        run: |
          response=$(curl -s -o /dev/null -w "%{http_code}" ${{ secrets.APP_URL }}/api/health)
          if [ $response != "200" ]; then
            echo "Health check failed with status $response"
            exit 1
          fi
```

### Error Tracking (Sentry)

```typescript
// sentry.client.config.ts
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
})
```

---

## 7. Security

### Secrets 管理

```bash
# GitHub Secrets (Settings → Secrets)
OPENAI_API_KEY
DATABASE_URL
VERCEL_TOKEN

# 永远不要在代码中硬编码
# 永远不要提交 .env.local
```

### Dependabot

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

---

## 8. Quick Deploy Configs

### Railway

```json
// railway.json
{
  "build": {
    "builder": "nixpacks"
  },
  "deploy": {
    "startCommand": "pnpm start",
    "healthcheckPath": "/api/health"
  }
}
```

### Fly.io

```toml
# fly.toml
app = "my-app"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true

[env]
  NODE_ENV = "production"
```

---

## Quick Reference

### 部署平台选择

| 平台 | 优势 | 适合场景 |
|------|------|----------|
| Vercel | Next.js 原生支持 | 大部分项目 |
| Railway | 简单、数据库集成 | 需要后端服务 |
| Fly.io | 全球边缘、Docker | 需要低延迟 |
| 自建 VPS | 完全控制 | 特殊需求 |

### 必备 Secrets

```
DATABASE_URL, OPENAI_API_KEY, VERCEL_TOKEN, SENTRY_DSN
```
