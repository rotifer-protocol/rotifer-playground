---
name: api-designer
description: Design RESTful and tRPC APIs with consistent patterns, error handling, and documentation. Define endpoint structure, response formats, and error codes. Use when designing APIs, creating endpoints, or when the user mentions API, endpoint, REST, tRPC, or response format.
---

# API Designer (API 设计师)

**Goal**: 设计一致、可预测、易于使用的 API 接口。

---

## 1. RESTful API Design

### URL 结构

```
# 资源命名 (名词复数)
GET    /api/users           # 列表
GET    /api/users/:id       # 详情
POST   /api/users           # 创建
PUT    /api/users/:id       # 全量更新
PATCH  /api/users/:id       # 部分更新
DELETE /api/users/:id       # 删除

# 嵌套资源
GET    /api/users/:id/posts
POST   /api/users/:id/posts

# 操作 (动词，仅在必要时)
POST   /api/users/:id/activate
POST   /api/chat/completions
```

### HTTP 方法语义

| Method | 幂等 | 安全 | 用途 |
|--------|------|------|------|
| GET | ✅ | ✅ | 读取资源 |
| POST | ❌ | ❌ | 创建资源/执行操作 |
| PUT | ✅ | ❌ | 全量替换 |
| PATCH | ❌ | ❌ | 部分更新 |
| DELETE | ✅ | ❌ | 删除资源 |

### HTTP 状态码

```typescript
// 成功
200 OK              // 通用成功
201 Created         // 创建成功
204 No Content      // 删除成功

// 客户端错误
400 Bad Request     // 请求格式错误
401 Unauthorized    // 未认证
403 Forbidden       // 无权限
404 Not Found       // 资源不存在
409 Conflict        // 冲突 (如重复创建)
422 Unprocessable   // 验证失败
429 Too Many Reqs   // 限流

// 服务端错误
500 Internal Error  // 服务器错误
502 Bad Gateway     // 上游错误
503 Unavailable     // 服务不可用
```

---

## 2. Response Format

### 成功响应

```typescript
// 单个资源
{
  "data": {
    "id": "123",
    "type": "user",
    "attributes": {
      "name": "张三",
      "email": "zhang@example.com"
    }
  }
}

// 简化版 (推荐 OPC)
{
  "id": "123",
  "name": "张三",
  "email": "zhang@example.com"
}
```

### 列表响应

```typescript
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

### 错误响应

```typescript
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数验证失败",
    "details": [
      { "field": "email", "message": "邮箱格式不正确" },
      { "field": "password", "message": "密码至少 8 位" }
    ]
  }
}
```

---

## 3. Error Code System

### 错误码设计

```typescript
// types/errors.ts
export const ERROR_CODES = {
  // 认证 (1xxx)
  AUTH_REQUIRED: { code: 1001, status: 401, message: '请先登录' },
  AUTH_EXPIRED: { code: 1002, status: 401, message: '登录已过期' },
  AUTH_INVALID: { code: 1003, status: 401, message: '认证信息无效' },
  
  // 权限 (2xxx)
  FORBIDDEN: { code: 2001, status: 403, message: '无权限访问' },
  
  // 资源 (3xxx)
  NOT_FOUND: { code: 3001, status: 404, message: '资源不存在' },
  ALREADY_EXISTS: { code: 3002, status: 409, message: '资源已存在' },
  
  // 验证 (4xxx)
  VALIDATION_ERROR: { code: 4001, status: 422, message: '参数验证失败' },
  INVALID_FORMAT: { code: 4002, status: 400, message: '请求格式错误' },
  
  // 限流 (5xxx)
  RATE_LIMITED: { code: 5001, status: 429, message: '请求过于频繁' },
  
  // AI 相关 (6xxx)
  AI_TOKEN_LIMIT: { code: 6001, status: 400, message: 'Token 超出限制' },
  AI_TIMEOUT: { code: 6002, status: 504, message: 'AI 响应超时' },
  AI_UNAVAILABLE: { code: 6003, status: 503, message: 'AI 服务不可用' },
  
  // Web3 相关 (7xxx)
  WALLET_NOT_CONNECTED: { code: 7001, status: 400, message: '钱包未连接' },
  INVALID_SIGNATURE: { code: 7002, status: 401, message: '签名验证失败' },
  INSUFFICIENT_BALANCE: { code: 7003, status: 400, message: '余额不足' },
  
  // 服务器 (9xxx)
  INTERNAL_ERROR: { code: 9001, status: 500, message: '服务器错误' },
} as const
```

### 错误处理工具

```typescript
// lib/api/error.ts
import { ERROR_CODES } from '@/types/errors'

export class APIError extends Error {
  constructor(
    public code: keyof typeof ERROR_CODES,
    public details?: unknown
  ) {
    super(ERROR_CODES[code].message)
  }
  
  toResponse() {
    const { code: errorCode, status, message } = ERROR_CODES[this.code]
    return Response.json(
      { error: { code: this.code, message, details: this.details } },
      { status }
    )
  }
}

// 使用
throw new APIError('VALIDATION_ERROR', [
  { field: 'email', message: '邮箱格式不正确' }
])
```

---

## 4. Query Parameters

### 分页

```
GET /api/users?page=1&pageSize=20
GET /api/users?cursor=abc123&limit=20  # 游标分页
```

### 过滤

```
GET /api/users?status=active
GET /api/users?role=admin,user
GET /api/users?createdAt[gte]=2024-01-01
```

### 排序

```
GET /api/users?sort=createdAt       # 升序
GET /api/users?sort=-createdAt      # 降序
GET /api/users?sort=-createdAt,name # 多字段
```

### 字段选择

```
GET /api/users?fields=id,name,email
GET /api/users?include=posts,comments
```

---

## 5. API Versioning

### URL 版本 (推荐)

```
/api/v1/users
/api/v2/users
```

### 版本迁移策略

```typescript
// 同时支持多版本
// app/api/v1/users/route.ts
export async function GET() {
  return formatV1Response(users)
}

// app/api/v2/users/route.ts
export async function GET() {
  return formatV2Response(users)
}
```

---

## 6. Next.js API Routes

### 基础结构

```typescript
// app/api/users/route.ts
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { APIError } from '@/lib/api/error'

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const data = CreateUserSchema.parse(body)
    
    const user = await createUser(data)
    
    return Response.json(user, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new APIError('VALIDATION_ERROR', error.errors).toResponse()
    }
    if (error instanceof APIError) {
      return error.toResponse()
    }
    return new APIError('INTERNAL_ERROR').toResponse()
  }
}
```

### 动态路由

```typescript
// app/api/users/[id]/route.ts
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await findUser(params.id)
  
  if (!user) {
    return new APIError('NOT_FOUND').toResponse()
  }
  
  return Response.json(user)
}
```

### 中间件模式

```typescript
// lib/api/middleware.ts
type Handler = (req: NextRequest, ctx: any) => Promise<Response>

export function withAuth(handler: Handler): Handler {
  return async (req, ctx) => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    
    if (!token) {
      return new APIError('AUTH_REQUIRED').toResponse()
    }
    
    const user = await verifyToken(token)
    if (!user) {
      return new APIError('AUTH_INVALID').toResponse()
    }
    
    // 注入用户信息
    ;(req as any).user = user
    
    return handler(req, ctx)
  }
}

// 使用
export const GET = withAuth(async (req) => {
  const user = (req as any).user
  return Response.json({ user })
})
```

---

## 7. tRPC Design (Alternative)

### 定义 Router

```typescript
// server/routers/user.ts
import { z } from 'zod'
import { router, publicProcedure, protectedProcedure } from '../trpc'

export const userRouter = router({
  list: publicProcedure
    .input(z.object({
      page: z.number().default(1),
      pageSize: z.number().default(20),
    }))
    .query(async ({ input }) => {
      return getUsers(input)
    }),
    
  create: protectedProcedure
    .input(z.object({
      name: z.string(),
      email: z.string().email(),
    }))
    .mutation(async ({ input, ctx }) => {
      return createUser(input, ctx.user)
    }),
})
```

### 合并 Router

```typescript
// server/routers/_app.ts
export const appRouter = router({
  user: userRouter,
  chat: chatRouter,
  wallet: walletRouter,
})

export type AppRouter = typeof appRouter
```

---

## 8. Streaming API (AI)

### Server-Sent Events

```typescript
// app/api/chat/route.ts
export async function POST(request: NextRequest) {
  const { messages } = await request.json()
  
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      
      for await (const chunk of streamChat(messages)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

---

## Quick Reference

### 端点命名

```
✅ /api/users           (复数名词)
✅ /api/user-profiles   (kebab-case)
❌ /api/getUsers        (不用动词)
❌ /api/user            (不用单数)
```

### 状态码速查

```
200 - 成功 (读取/更新)
201 - 创建成功
204 - 删除成功
400 - 请求错误
401 - 未认证
403 - 无权限
404 - 不存在
422 - 验证失败
429 - 限流
500 - 服务器错误
```

### 推荐库

```
zod         - 验证
@trpc/server - tRPC
@upstash/ratelimit - 限流
```
