---
name: debugger
description: Systematic debugging guide for AI and Web3 applications. Diagnose errors, analyze logs, and identify root causes. Use when troubleshooting issues, analyzing errors, or when the user mentions bug, error, not working, debug, or fix.
---

# Debugger (问题诊断师)

**Goal**: 系统化排查问题，快速定位根因，提供修复方案。

**原则**: 不要猜，要验证。

---

## Debugging Mindset

```
问题 → 复现 → 隔离 → 定位 → 修复 → 验证
```

### 排查黄金法则

1. **先复现**: 不能稳定复现的问题不要急着修
2. **二分法**: 缩小范围，逐步排除
3. **看日志**: 错误信息是最好的线索
4. **最小化**: 创建最小复现用例
5. **记录**: 记录排查过程，避免重复尝试

---

## 1. Error Classification

### 错误类型速查

| 错误类型 | 常见原因 | 排查方向 |
|----------|----------|----------|
| TypeError | null/undefined 访问 | 检查数据流 |
| SyntaxError | 代码语法错误 | 检查引号、括号 |
| ReferenceError | 变量未定义 | 检查作用域、导入 |
| NetworkError | 网络/API 问题 | 检查请求、响应 |
| TimeoutError | 操作超时 | 检查异步逻辑 |
| ValidationError | 数据验证失败 | 检查输入格式 |

### 分层排查

```
前端 ─── 网络 ─── 后端 ─── 数据库 ─── 外部服务
  ↓       ↓       ↓        ↓          ↓
 Console  Network  Logs    Query      API Logs
```

---

## 2. Frontend Debugging

### Console 技巧

```typescript
// 基础
console.log('value:', value)

// 表格 (数组/对象)
console.table(users)

// 分组
console.group('API Request')
console.log('URL:', url)
console.log('Payload:', payload)
console.groupEnd()

// 计时
console.time('fetch')
await fetch(url)
console.timeEnd('fetch')

// 条件断点
if (user.id === 'problem-id') {
  debugger
}
```

### React DevTools

```
1. Components 面板 → 检查 props/state
2. Profiler 面板 → 检查重渲染
3. 搜索组件名快速定位
```

### 常见前端问题

| 症状 | 可能原因 | 解决方案 |
|------|----------|----------|
| 白屏 | JS 错误阻断渲染 | 检查 Console 错误 |
| 不更新 | State 引用未变 | 确保返回新对象 |
| 闪烁 | 条件渲染逻辑错误 | 添加 loading 状态 |
| 无限循环 | useEffect 依赖错误 | 检查依赖数组 |
| 内存泄漏 | 未清理订阅/定时器 | 添加 cleanup |

### React 常见坑

```typescript
// ❌ 无限循环
useEffect(() => {
  setData(fetchData()) // 触发重渲染，又触发 effect
})

// ✅ 正确
useEffect(() => {
  fetchData().then(setData)
}, []) // 空依赖

// ❌ State 不更新
const [items, setItems] = useState([])
items.push(newItem) // 直接修改
setItems(items) // 引用没变，不更新

// ✅ 正确
setItems([...items, newItem])
```

---

## 3. Network Debugging

### 检查请求

```
DevTools → Network 面板
1. 请求是否发出？
2. URL 是否正确？
3. Headers 是否正确？(Authorization, Content-Type)
4. Payload 是否正确？
5. 响应状态码？
6. 响应内容？
```

### 常见网络问题

| 状态码 | 可能原因 | 排查方向 |
|--------|----------|----------|
| 400 | 请求格式错误 | 检查请求体 |
| 401 | 认证失败 | 检查 token |
| 403 | 权限不足 | 检查用户权限 |
| 404 | 路径错误 | 检查 URL |
| 405 | 方法错误 | 检查 HTTP 方法 |
| 500 | 服务端错误 | 查看服务端日志 |
| 502/503 | 服务不可用 | 检查部署状态 |

### CORS 问题

```
错误: Access-Control-Allow-Origin

排查:
1. 服务端是否设置 CORS headers？
2. 预检请求 (OPTIONS) 是否正确响应？
3. 是否使用了不允许的 header？
```

---

## 4. AI API Debugging

### 常见 AI 错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| 401 Invalid API Key | 密钥错误/过期 | 检查环境变量 |
| 429 Rate Limited | 请求过快 | 添加重试/限流 |
| 400 Token Limit | 上下文过长 | 截断/分块 |
| 500 Server Error | OpenAI 服务问题 | 添加 fallback |
| Timeout | 响应时间过长 | 增加超时/用流式 |

### 排查步骤

```typescript
// 1. 检查 API 密钥
console.log('API Key exists:', !!process.env.OPENAI_API_KEY)
console.log('API Key prefix:', process.env.OPENAI_API_KEY?.slice(0, 7))

// 2. 检查请求参数
console.log('Messages count:', messages.length)
console.log('Token estimate:', estimateTokens(messages))

// 3. 检查响应
try {
  const response = await openai.chat.completions.create({...})
  console.log('Usage:', response.usage)
} catch (error) {
  console.error('Error type:', error.constructor.name)
  console.error('Error message:', error.message)
  console.error('Error code:', error.code)
}
```

### Token 超限处理

```typescript
// 估算 token 数
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) // 粗略估算
}

// 截断策略
function truncateMessages(messages: Message[], maxTokens: number): Message[] {
  let total = 0
  const result: Message[] = []
  
  // 从最新消息往前保留
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].content)
    if (total + tokens > maxTokens) break
    result.unshift(messages[i])
    total += tokens
  }
  
  return result
}
```

---

## 5. Web3 Debugging

### 常见 Web3 错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| User rejected | 用户拒绝签名 | 添加用户提示 |
| Insufficient funds | 余额不足 | 检查余额+Gas |
| Nonce too low | Nonce 冲突 | 等待或加速前一笔 |
| Gas estimation failed | 交易会失败 | 检查参数/权限 |
| Network mismatch | 网络不匹配 | 提示切换网络 |

### 交易排查

```typescript
// 1. 检查钱包状态
console.log('Connected:', isConnected)
console.log('Address:', address)
console.log('Chain ID:', chainId)

// 2. 检查余额
const balance = await publicClient.getBalance({ address })
console.log('Balance:', formatEther(balance))

// 3. 模拟交易
try {
  await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'transfer',
    args: [to, amount],
  })
  console.log('Simulation passed')
} catch (error) {
  console.error('Simulation failed:', error.message)
}

// 4. 检查 Gas
const gasEstimate = await publicClient.estimateContractGas({...})
console.log('Gas estimate:', gasEstimate)
```

### 交易追踪

```typescript
// 使用 Etherscan API 查询交易状态
const txStatus = await fetch(
  `https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=${hash}`
)

// 或使用 viem
const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log('Status:', receipt.status) // 'success' | 'reverted'
console.log('Gas used:', receipt.gasUsed)
```

---

## 6. Backend Debugging

### 日志级别

```typescript
// lib/logger.ts
const logger = {
  debug: (msg: string, data?: object) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[DEBUG] ${msg}`, data)
    }
  },
  info: (msg: string, data?: object) => {
    console.log(`[INFO] ${msg}`, data)
  },
  warn: (msg: string, data?: object) => {
    console.warn(`[WARN] ${msg}`, data)
  },
  error: (msg: string, error?: Error) => {
    console.error(`[ERROR] ${msg}`, {
      message: error?.message,
      stack: error?.stack,
    })
  },
}
```

### 请求追踪

```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  const requestId = crypto.randomUUID()
  
  console.log(`[${requestId}] ${request.method} ${request.url}`)
  
  const response = NextResponse.next()
  response.headers.set('x-request-id', requestId)
  
  return response
}
```

### 数据库调试

```typescript
// Prisma 查询日志
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
})

// 检查慢查询
prisma.$on('query', (e) => {
  if (e.duration > 100) {
    console.warn(`Slow query (${e.duration}ms):`, e.query)
  }
})
```

---

## 7. Debugging Checklist

### 通用排查清单

```markdown
## 问题排查清单

### 1. 信息收集
- [ ] 错误信息是什么？
- [ ] 哪个页面/功能出问题？
- [ ] 何时开始出现？
- [ ] 能否稳定复现？

### 2. 环境检查
- [ ] 本地还是生产环境？
- [ ] 特定浏览器/设备？
- [ ] 环境变量正确？
- [ ] 依赖版本正确？

### 3. 日志检查
- [ ] Console 有错误吗？
- [ ] Network 请求正常吗？
- [ ] 服务端日志有什么？

### 4. 代码检查
- [ ] 最近有什么改动？
- [ ] 是否引入了新依赖？
- [ ] 相关代码逻辑正确吗？

### 5. 隔离测试
- [ ] 最小复现用例
- [ ] 硬编码测试数据
- [ ] 逐步注释排除
```

---

## Quick Reference

### 调试工具

```
前端: Chrome DevTools, React DevTools
网络: Network 面板, Postman
后端: console.log, debugger, Prisma Studio
Web3: Etherscan, Tenderly
AI: OpenAI Playground
```

### 常用命令

```bash
# 查看日志
tail -f app.log

# 环境变量检查
printenv | grep API

# 端口占用
lsof -i :3000

# 进程查看
ps aux | grep node
```

### 二分法模板

```
1. 问题出现在 A 还是 B？
   → 确认是 A
2. 问题出现在 A1 还是 A2？
   → 确认是 A2
3. 问题出现在 A2a 还是 A2b？
   → 找到根因
```
