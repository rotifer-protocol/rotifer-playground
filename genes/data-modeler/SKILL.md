---
name: data-modeler
description: Design database schemas with Prisma for AI and Web3 applications. Define models, relations, indexes, and migrations. Use when designing databases, creating Prisma schemas, or when the user mentions database, schema, model, prisma, or migration.
---

# Data Modeler (数据建模师)

**Goal**: 设计清晰、高效、可扩展的数据库结构。

**技术栈**: Prisma + PostgreSQL (主要) / SQLite (开发)

---

## 1. Schema Design Principles

### 命名规范

```prisma
// 模型: PascalCase (单数)
model User {}
model ChatMessage {}

// 字段: camelCase
model User {
  id        String
  createdAt DateTime
  firstName String
}

// 关系字段: 描述关系
model Post {
  author    User    @relation(...)
  authorId  String
}
```

### 必备字段

```prisma
model BaseModel {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

// 所有模型都应包含这三个字段
model User {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  // 业务字段...
}
```

### 软删除 (推荐)

```prisma
model User {
  // ...
  deletedAt DateTime?  // null = 未删除
  
  @@index([deletedAt])
}

// 查询时过滤
const users = await prisma.user.findMany({
  where: { deletedAt: null }
})
```

---

## 2. Common Patterns

### 用户认证

```prisma
model User {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  // 认证
  email         String    @unique
  emailVerified DateTime?
  passwordHash  String?   // null if OAuth only
  
  // 资料
  name      String?
  image     String?
  
  // 关系
  accounts  Account[]
  sessions  Session[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  
  // OAuth tokens
  accessToken  String?
  refreshToken String?
  expiresAt    Int?
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

### AI 对话

```prisma
model Conversation {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  title     String?
  userId    String
  
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages  Message[]
  
  @@index([userId])
}

model Message {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  
  role           String   // 'user' | 'assistant' | 'system'
  content        String   @db.Text
  conversationId String
  
  // Token 统计
  promptTokens     Int?
  completionTokens Int?
  
  // AI 元数据
  model     String?
  finishReason String?
  
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  
  @@index([conversationId])
}
```

### Web3 用户

```prisma
model User {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  // Web3
  address   String   @unique  // 0x...
  chainId   Int      @default(1)
  
  // ENS (缓存)
  ensName   String?
  ensAvatar String?
  ensUpdatedAt DateTime?
  
  // 关系
  wallets   Wallet[]
  
  @@index([address])
}

model Wallet {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  
  address   String
  chainId   Int
  label     String?  // "Main", "Trading", etc.
  
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([userId, address, chainId])
}
```

### 交易记录

```prisma
model Transaction {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  
  hash      String   @unique
  chainId   Int
  
  from      String
  to        String?
  value     Decimal  @db.Decimal(78, 0)  // BigInt as Decimal
  
  status    TransactionStatus @default(PENDING)
  
  // Gas
  gasLimit  Decimal? @db.Decimal(78, 0)
  gasUsed   Decimal? @db.Decimal(78, 0)
  gasPrice  Decimal? @db.Decimal(78, 0)
  
  // 关系
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  
  @@index([userId])
  @@index([hash])
  @@index([status])
}

enum TransactionStatus {
  PENDING
  CONFIRMED
  FAILED
}
```

---

## 3. Relations

### 一对多

```prisma
model User {
  id    String @id
  posts Post[]
}

model Post {
  id       String @id
  author   User   @relation(fields: [authorId], references: [id])
  authorId String
  
  @@index([authorId])
}
```

### 多对多 (显式)

```prisma
model User {
  id          String       @id
  memberships Membership[]
}

model Team {
  id          String       @id
  memberships Membership[]
}

model Membership {
  id     String @id @default(cuid())
  role   String @default("member")  // "owner" | "admin" | "member"
  
  userId String
  teamId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  team   Team   @relation(fields: [teamId], references: [id], onDelete: Cascade)
  
  @@unique([userId, teamId])
}
```

### 自引用

```prisma
model Category {
  id       String     @id
  name     String
  
  parentId String?
  parent   Category?  @relation("CategoryHierarchy", fields: [parentId], references: [id])
  children Category[] @relation("CategoryHierarchy")
}
```

---

## 4. Indexes & Performance

### 索引策略

```prisma
model User {
  id        String   @id
  email     String   @unique  // 自动索引
  createdAt DateTime
  status    String
  
  // 复合索引 (常用查询)
  @@index([status, createdAt])
  
  // 单字段索引
  @@index([createdAt])
}
```

### 何时添加索引

| 场景 | 需要索引 |
|------|----------|
| WHERE 条件字段 | ✅ |
| ORDER BY 字段 | ✅ |
| 外键字段 | ✅ (手动添加) |
| JOIN 条件 | ✅ |
| 唯一约束字段 | 自动 |

### BigInt 处理

```prisma
// 方式 1: Decimal (推荐)
model Token {
  balance Decimal @db.Decimal(78, 0)  // 最大 uint256
}

// 方式 2: BigInt (Prisma 4.x+)
model Token {
  balance BigInt
}
```

---

## 5. Migrations

### 开发流程

```bash
# 1. 修改 schema.prisma

# 2. 创建迁移
pnpm prisma migrate dev --name add_user_avatar

# 3. 应用到开发库 (自动)
```

### 生产部署

```bash
# CI/CD 中运行
pnpm prisma migrate deploy
```

### 迁移最佳实践

```bash
# ✅ 小步迁移
add_user_table
add_user_email_index
add_user_avatar_field

# ❌ 大爆炸迁移
initial_schema_with_everything
```

### 数据迁移

```typescript
// prisma/migrations/xxx/data-migration.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // 填充默认值
  await prisma.user.updateMany({
    where: { role: null },
    data: { role: 'user' }
  })
}

main()
```

---

## 6. Query Patterns

### 常用查询

```typescript
// 分页
const users = await prisma.user.findMany({
  skip: (page - 1) * pageSize,
  take: pageSize,
  orderBy: { createdAt: 'desc' },
})

// 包含关系
const user = await prisma.user.findUnique({
  where: { id },
  include: { posts: true },
})

// 选择字段
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },
})

// 统计
const count = await prisma.user.count({
  where: { status: 'active' },
})
```

### 事务

```typescript
// 隐式事务
const [user, post] = await prisma.$transaction([
  prisma.user.create({ data: userData }),
  prisma.post.create({ data: postData }),
])

// 交互式事务
await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: userData })
  await tx.post.create({ 
    data: { ...postData, authorId: user.id } 
  })
})
```

---

## 7. Schema Checklist

```markdown
## 数据模型检查清单

### 基础
- [ ] 所有模型有 id, createdAt, updatedAt
- [ ] 使用正确的命名规范
- [ ] 外键字段有索引

### 关系
- [ ] onDelete 策略明确 (Cascade/SetNull/Restrict)
- [ ] 多对多使用显式中间表
- [ ] 自引用关系正确

### 性能
- [ ] 常用查询字段有索引
- [ ] 复合索引顺序正确
- [ ] BigInt 使用 Decimal

### 安全
- [ ] 敏感字段不直接暴露
- [ ] 软删除用于重要数据
- [ ] 审计字段 (createdBy, updatedBy)
```

---

## Quick Reference

### Prisma CLI

```bash
prisma generate      # 生成客户端
prisma migrate dev   # 创建迁移
prisma migrate deploy # 部署迁移
prisma studio        # 可视化界面
```
