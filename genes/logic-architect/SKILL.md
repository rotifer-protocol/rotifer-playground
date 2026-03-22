---
name: logic-architect
description: Ensure code has sound business logic, data flow, and technical implementation for AI and Web3 projects. Focus on architecture, edge cases, state management, agent patterns, and wallet safety. Use when writing core logic, reviewing architecture, implementing APIs, or when the user mentions logic, architecture, data flow, or asks for code review ignoring UI.
---

# The Logic Architect (逻辑与架构专家)

**Goal**: 确保代码在商业逻辑、数据流转和技术实现上无懈可击。**忽略 UI 细节**。

**专注领域**: AI 应用架构 + Web3 安全逻辑

---

## Pre-Code Checklist

```
Logic Integrity Check:
- [ ] Edge cases: 0 items? 10000 items? Timeout? 
- [ ] State flow: Start → Loading → Success/Error → Reset (闭环?)
- [ ] Data privacy: No secrets/keys sent to wrong endpoints?
- [ ] OPC efficiency: Is this the simplest maintainable solution?
- [ ] AI: Token limits? Streaming? Fallback model?
- [ ] Web3: Wallet states? Chain switching? Gas estimation?
```

---

## 1. Strategic Filters (战略过滤器)

### OPC Efficiency (一人公司原则)

| Question | If No → Action |
|----------|----------------|
| 能自动化吗？ | 寻找可自动化方案或接受手动成本 |
| 维护成本低吗？ | 简化设计，减少移动部件 |
| 有现成方案吗？ | 优先使用成熟库/服务 |
| 未来我能看懂吗？ | 添加注释，简化逻辑 |

**拒绝清单**:
- 过度抽象（不需要时不要搞 Factory Pattern）
- 自建可外包的基础设施（Auth, Payment, Email）
- 需要 24/7 监控的复杂架构

---

## 2. AI Architecture Patterns

### AI Response Type System

```typescript
// 统一 AI 响应类型（兼容多 SDK）
type AIResponse<T> = 
  | { ok: true; data: T; usage?: TokenUsage }
  | { ok: false; error: AIError }

type AIError = 
  | { code: 'RATE_LIMITED'; retryAfter: number }
  | { code: 'TOKEN_LIMIT'; used: number; limit: number }
  | { code: 'CONTEXT_LENGTH'; maxTokens: number }
  | { code: 'INVALID_RESPONSE'; raw: unknown }
  | { code: 'TIMEOUT' }
  | { code: 'MODERATION_FLAGGED'; categories: string[] }

type TokenUsage = {
  prompt: number
  completion: number
  total: number
  cost?: number  // USD
}
```

### Streaming Pattern

```typescript
// 流式响应处理（Vercel AI SDK 风格）
async function* streamChat(messages: Message[]): AsyncGenerator<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages,
    stream: true,
  })
  
  for await (const chunk of response) {
    const content = chunk.choices[0]?.delta?.content
    if (content) yield content
  }
}

// 使用 Vercel AI SDK 时
import { streamText } from 'ai'
const { textStream } = await streamText({
  model: openai('gpt-4'),
  messages,
})
```

### Multi-Model Fallback

```typescript
// 模型降级策略
const MODEL_CHAIN = [
  { model: 'gpt-4o', maxTokens: 128000 },
  { model: 'gpt-4o-mini', maxTokens: 128000 },
  { model: 'claude-3-5-sonnet', maxTokens: 200000 },
] as const

async function callWithFallback<T>(
  prompt: string,
  schema: ZodSchema<T>
): Promise<T> {
  for (const { model } of MODEL_CHAIN) {
    try {
      return await generateObject({ model, prompt, schema })
    } catch (e) {
      if (isLastModel(model)) throw e
      console.warn(`${model} failed, falling back...`)
    }
  }
  throw new Error('All models failed')
}
```

### Context Management

```typescript
// 长对话上下文管理
function truncateContext(
  messages: Message[],
  maxTokens: number
): Message[] {
  // 保留: system prompt + 最近 N 条
  const system = messages.filter(m => m.role === 'system')
  const others = messages.filter(m => m.role !== 'system')
  
  let tokenCount = countTokens(system)
  const kept: Message[] = []
  
  // 从最新往前保留
  for (let i = others.length - 1; i >= 0; i--) {
    const msgTokens = countTokens([others[i]])
    if (tokenCount + msgTokens > maxTokens) break
    kept.unshift(others[i])
    tokenCount += msgTokens
  }
  
  return [...system, ...kept]
}
```

### Agent / Tool Pattern

```typescript
// Agent 工具调用模式
interface Tool<TInput, TOutput> {
  name: string
  description: string
  schema: ZodSchema<TInput>
  execute: (input: TInput) => Promise<TOutput>
}

// 工具执行循环
async function agentLoop(
  initialPrompt: string,
  tools: Tool[],
  maxIterations = 10
): Promise<string> {
  let messages = [{ role: 'user', content: initialPrompt }]
  
  for (let i = 0; i < maxIterations; i++) {
    const response = await llm.chat({ messages, tools })
    
    if (response.finishReason === 'stop') {
      return response.content
    }
    
    if (response.finishReason === 'tool_calls') {
      for (const call of response.toolCalls) {
        const tool = tools.find(t => t.name === call.name)
        const result = await tool.execute(call.args)
        messages.push({ role: 'tool', content: result, toolCallId: call.id })
      }
    }
  }
  throw new Error('Max iterations reached')
}
```

### Cost Control

```typescript
// 成本追踪
const PRICING = {
  'gpt-4o': { input: 2.5, output: 10 },       // per 1M tokens
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
} as const

function calculateCost(model: string, usage: TokenUsage): number {
  const price = PRICING[model]
  return (usage.prompt * price.input + usage.completion * price.output) / 1_000_000
}

// 预算控制
async function withBudget<T>(
  fn: () => Promise<{ result: T; usage: TokenUsage }>,
  maxCostUSD: number
): Promise<T> {
  const { result, usage } = await fn()
  const cost = calculateCost(currentModel, usage)
  if (cost > maxCostUSD) {
    throw new Error(`Cost ${cost} exceeds budget ${maxCostUSD}`)
  }
  return result
}
```

---

## 3. Web3 Architecture Patterns

### Wallet State Machine

```typescript
// 完整钱包状态（wagmi + viem / ethers 通用）
type WalletState = 
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; address: Address; chainId: number }
  | { status: 'wrong_network'; expected: number; actual: number }
  | { status: 'signing'; message: string }
  | { status: 'tx_pending'; hash: Hash }
  | { status: 'tx_confirmed'; hash: Hash; receipt: TransactionReceipt }
  | { status: 'tx_failed'; hash?: Hash; error: Error }

// 状态转换
// disconnected → connecting → connected
//                          → wrong_network → (switch) → connected
// connected → signing → connected
// connected → tx_pending → tx_confirmed
//                       → tx_failed
```

### Transaction Pattern (wagmi + viem)

```typescript
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'

function useContractWrite() {
  const { writeContract, data: hash, isPending, error } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  async function execute(args: ContractArgs) {
    // Pre-flight checks
    if (!address) throw new Error('Wallet not connected')
    if (chainId !== expectedChainId) throw new Error('Wrong network')
    
    // Gas estimation with buffer
    const gasEstimate = await publicClient.estimateContractGas(args)
    const gasLimit = gasEstimate * 120n / 100n  // 20% buffer
    
    writeContract({ ...args, gas: gasLimit })
  }

  return { execute, hash, isPending, isConfirming, isSuccess, error }
}
```

### Transaction Pattern (ethers.js)

```typescript
import { ethers } from 'ethers'

async function executeTransaction(
  contract: ethers.Contract,
  method: string,
  args: unknown[]
): Promise<TransactionReceipt> {
  // Gas estimation
  const gasEstimate = await contract[method].estimateGas(...args)
  const gasLimit = gasEstimate * 120n / 100n
  
  // Execute
  const tx = await contract[method](...args, { gasLimit })
  
  // Wait for confirmation
  const receipt = await tx.wait(1)  // 1 confirmation
  
  if (receipt.status === 0) {
    throw new Error('Transaction reverted')
  }
  
  return receipt
}
```

### BigInt Handling

```typescript
// BigInt 格式化（禁止精度丢失）
import { formatUnits, parseUnits } from 'viem'

// ✅ 正确
const amount = parseUnits('1.5', 18)  // 1.5 ETH → bigint
const display = formatUnits(balance, 18)  // bigint → string

// ❌ 禁止（精度丢失）
const bad = Number(balance)  // 大数会丢失精度
const worse = balance / 10n ** 18n  // 整除丢失小数
```

### Chain Configuration

```typescript
// 多链配置
const SUPPORTED_CHAINS = {
  1: { name: 'Ethereum', rpc: process.env.ETH_RPC_URL },
  137: { name: 'Polygon', rpc: process.env.POLYGON_RPC_URL },
  42161: { name: 'Arbitrum', rpc: process.env.ARB_RPC_URL },
} as const

type SupportedChainId = keyof typeof SUPPORTED_CHAINS

function getChainConfig(chainId: number): ChainConfig {
  const config = SUPPORTED_CHAINS[chainId as SupportedChainId]
  if (!config) throw new Error(`Unsupported chain: ${chainId}`)
  return config
}
```

---

## 4. Logic Integrity Protocol

### Edge Cases Matrix

| Scenario | Expected Behavior |
|----------|------------------|
| `items.length === 0` | ? |
| `items.length === 1` | ? |
| `items.length > 1000` | ? (分页/虚拟化?) |
| `network timeout` | ? |
| `AI token limit hit` | ? (truncate/split?) |
| `wallet disconnected mid-tx` | ? |
| `gas price spike` | ? |

### State Management Pattern

```typescript
type AsyncState<T, E = Error> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: E }

// AI 特化版
type AIStreamState<T> =
  | { status: 'idle' }
  | { status: 'streaming'; partial: string }
  | { status: 'success'; data: T; usage: TokenUsage }
  | { status: 'error'; error: AIError }
```

### Data Privacy Rules

```
NEVER send to external endpoints:
- Private keys / seed phrases / mnemonics
- Wallet signatures without user consent
- AI prompts containing user PII
- API keys in client-side code

ALWAYS:
- Mask addresses in logs (0x1234...5678)
- Use server-side for AI API calls
- Validate transaction parameters before signing
- Rate limit AI endpoints
```

---

## 5. Review Checklist

```markdown
## Logic Review

### Correctness
- [ ] 所有边界条件都有处理
- [ ] 状态流转形成闭环
- [ ] 错误信息对调试有帮助

### AI Specific
- [ ] Token 超限有降级策略
- [ ] 流式响应正确处理
- [ ] 幻觉有验证机制
- [ ] 成本可追踪

### Web3 Specific
- [ ] 钱包状态全覆盖
- [ ] BigInt 正确处理
- [ ] Gas 估算有 buffer
- [ ] 链切换有处理

### Security  
- [ ] 无敏感数据泄露
- [ ] 输入已验证/清洗
- [ ] 权限检查到位
```

---

## Quick Reference

### Common Patterns

```typescript
// Retry with backoff
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T>

// Timeout wrapper
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>

// Debounce for inputs
function debounce<T extends (...args: any[]) => any>(fn: T, ms: number)
```

### AI SDK Quick Reference

```typescript
// Vercel AI SDK
import { generateText, streamText, generateObject } from 'ai'
import { openai } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'

// OpenAI SDK
import OpenAI from 'openai'
const client = new OpenAI()

// LangChain
import { ChatOpenAI } from '@langchain/openai'
```

### Web3 SDK Quick Reference

```typescript
// wagmi + viem
import { useAccount, useConnect, useWriteContract } from 'wagmi'
import { parseUnits, formatUnits, Address } from 'viem'

// ethers.js
import { ethers, parseEther, formatEther } from 'ethers'
```
