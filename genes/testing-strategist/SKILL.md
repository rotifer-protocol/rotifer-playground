---
name: testing-strategist
description: Design testing strategies for AI and Web3 applications. Create test cases, mock data, and CI configurations. Use when writing tests, setting up test infrastructure, or when the user mentions testing, test coverage, unit test, integration test, or e2e.
---

# Testing Strategist (测试策略师)

**Goal**: 为 AI + Web3 应用设计高效的测试策略，确保代码质量和系统稳定性。

**OPC 原则**: 测试要精准，不追求 100% 覆盖率，聚焦核心路径。

---

## Testing Philosophy

```
测试金字塔 (OPC 版):
                    ┌─────────┐
                    │  E2E    │  ← 最少 (关键用户流程)
                   ─┴─────────┴─
                 ┌───────────────┐
                 │  Integration  │  ← 适量 (API/DB)
               ──┴───────────────┴──
             ┌───────────────────────┐
             │      Unit Tests       │  ← 最多 (纯函数)
           ──┴───────────────────────┴──
```

---

## 1. Unit Testing

### Pure Functions (优先测试)

```typescript
// utils/format.test.ts
import { describe, it, expect } from 'vitest'
import { truncateAddress, formatTokenAmount } from './format'

describe('truncateAddress', () => {
  it('truncates correctly', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678'))
      .toBe('0x1234...5678')
  })
  
  it('handles short addresses', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234')
  })
  
  it('handles empty input', () => {
    expect(truncateAddress('')).toBe('')
  })
})

describe('formatTokenAmount', () => {
  it('formats large numbers with decimals', () => {
    expect(formatTokenAmount(1500000000000000000n, 18)).toBe('1.5')
  })
  
  it('handles zero', () => {
    expect(formatTokenAmount(0n, 18)).toBe('0')
  })
})
```

### Testing Hooks

```typescript
// hooks/useWallet.test.ts
import { renderHook, act } from '@testing-library/react'
import { useWallet } from './useWallet'

describe('useWallet', () => {
  it('starts disconnected', () => {
    const { result } = renderHook(() => useWallet())
    expect(result.current.status).toBe('disconnected')
  })
  
  it('connects successfully', async () => {
    const { result } = renderHook(() => useWallet())
    
    await act(async () => {
      await result.current.connect()
    })
    
    expect(result.current.status).toBe('connected')
  })
})
```

---

## 2. AI Testing Strategies

### Response Structure Testing

```typescript
// ai/analyzer.test.ts
import { describe, it, expect } from 'vitest'
import { analyzeText } from './analyzer'
import { AnalysisSchema } from './schemas'

describe('analyzeText', () => {
  it('returns valid schema', async () => {
    const result = await analyzeText('Test input')
    
    // 验证结构
    expect(() => AnalysisSchema.parse(result)).not.toThrow()
  })
  
  it('handles empty input gracefully', async () => {
    const result = await analyzeText('')
    
    expect(result.error).toBe('EMPTY_INPUT')
  })
})
```

### AI Response Mocking

```typescript
// __mocks__/ai.ts
export const mockAIResponse = (response: unknown) => {
  vi.mock('ai', () => ({
    generateObject: vi.fn().mockResolvedValue({ object: response }),
    generateText: vi.fn().mockResolvedValue({ text: JSON.stringify(response) }),
  }))
}

// 使用
describe('ChatService', () => {
  beforeEach(() => {
    mockAIResponse({
      summary: 'Test summary',
      sentiment: 'positive',
    })
  })
  
  it('processes AI response correctly', async () => {
    const result = await chatService.analyze('input')
    expect(result.summary).toBe('Test summary')
  })
})
```

### Snapshot Testing for Prompts

```typescript
// prompts/analyzer.test.ts
import { buildAnalyzerPrompt } from './analyzer'

describe('Analyzer Prompt', () => {
  it('generates consistent prompt', () => {
    const prompt = buildAnalyzerPrompt({
      input: 'Test data',
      context: 'Financial',
    })
    
    expect(prompt).toMatchSnapshot()
  })
})
```

### Deterministic Testing

```typescript
// 使用固定 seed 测试 AI 行为一致性
describe('AI Consistency', () => {
  it('produces consistent output for same input', async () => {
    const input = 'Analyze this market data'
    
    const results = await Promise.all([
      analyzeWithSeed(input, 42),
      analyzeWithSeed(input, 42),
    ])
    
    expect(results[0]).toEqual(results[1])
  })
})
```

---

## 3. Web3 Testing Strategies

### Contract Interaction Mocking

```typescript
// __mocks__/wagmi.ts
import { vi } from 'vitest'

export const mockUseAccount = (overrides = {}) => {
  return {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    isConnected: true,
    chainId: 1,
    ...overrides,
  }
}

export const mockUseWriteContract = () => ({
  writeContract: vi.fn(),
  isPending: false,
  error: null,
})
```

### Transaction Flow Testing

```typescript
// hooks/useTransfer.test.ts
describe('useTransfer', () => {
  it('handles successful transfer', async () => {
    const { result } = renderHook(() => useTransfer())
    
    await act(async () => {
      await result.current.transfer('0x...', 1000000000000000000n)
    })
    
    expect(result.current.status).toBe('confirmed')
    expect(result.current.hash).toBeDefined()
  })
  
  it('handles insufficient balance', async () => {
    mockBalance(0n) // 余额为 0
    
    const { result } = renderHook(() => useTransfer())
    
    await act(async () => {
      await result.current.transfer('0x...', 1000000000000000000n)
    })
    
    expect(result.current.error?.code).toBe('INSUFFICIENT_BALANCE')
  })
  
  it('handles network switch during tx', async () => {
    const { result } = renderHook(() => useTransfer())
    
    // 发起交易
    act(() => { result.current.transfer('0x...', 1n) })
    
    // 模拟网络切换
    act(() => { mockChainSwitch(137) })
    
    expect(result.current.error?.code).toBe('NETWORK_CHANGED')
  })
})
```

### BigInt Edge Cases

```typescript
describe('BigInt Handling', () => {
  it('handles max uint256', () => {
    const maxUint256 = 2n ** 256n - 1n
    expect(formatTokenAmount(maxUint256, 18)).not.toThrow()
  })
  
  it('handles precision correctly', () => {
    // 0.000000000000000001 ETH (1 wei)
    expect(formatTokenAmount(1n, 18)).toBe('0.000000000000000001')
  })
})
```

---

## 4. Integration Testing

### API Integration

```typescript
// api/chat.integration.test.ts
import { describe, it, expect } from 'vitest'

describe('Chat API', () => {
  it('POST /api/chat returns streamed response', async () => {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    })
    
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })
  
  it('handles rate limiting', async () => {
    // 快速发送多个请求
    const responses = await Promise.all(
      Array(10).fill(null).map(() => 
        fetch('/api/chat', { method: 'POST', body: '{}' })
      )
    )
    
    const rateLimited = responses.filter(r => r.status === 429)
    expect(rateLimited.length).toBeGreaterThan(0)
  })
})
```

### Database Integration

```typescript
// db/users.integration.test.ts
describe('User Repository', () => {
  beforeEach(async () => {
    await db.user.deleteMany()
  })
  
  it('creates and retrieves user', async () => {
    const user = await userRepo.create({
      address: '0x1234...',
      email: 'test@example.com',
    })
    
    const found = await userRepo.findByAddress('0x1234...')
    expect(found).toEqual(user)
  })
})
```

---

## 5. E2E Testing

### Critical User Flows

```typescript
// e2e/chat-flow.spec.ts
import { test, expect } from '@playwright/test'

test('complete chat flow', async ({ page }) => {
  await page.goto('/')
  
  // 连接钱包
  await page.click('[data-testid="connect-wallet"]')
  await page.click('[data-testid="metamask"]')
  
  // 发送消息
  await page.fill('[data-testid="chat-input"]', 'Hello AI')
  await page.click('[data-testid="send-button"]')
  
  // 等待响应
  await expect(page.locator('[data-testid="ai-response"]')).toBeVisible({
    timeout: 30000,
  })
  
  // 验证响应内容
  const response = await page.textContent('[data-testid="ai-response"]')
  expect(response?.length).toBeGreaterThan(0)
})
```

### Web3 Flow

```typescript
// e2e/transaction-flow.spec.ts
test('complete transaction flow', async ({ page }) => {
  await page.goto('/swap')
  
  // 输入金额
  await page.fill('[data-testid="amount-input"]', '0.1')
  
  // 检查 gas 估算
  await expect(page.locator('[data-testid="gas-estimate"]')).toBeVisible()
  
  // 点击交易
  await page.click('[data-testid="swap-button"]')
  
  // 等待钱包确认
  await expect(page.locator('[data-testid="tx-pending"]')).toBeVisible()
  
  // 等待确认 (mock 环境)
  await expect(page.locator('[data-testid="tx-confirmed"]')).toBeVisible({
    timeout: 60000,
  })
})
```

---

## 6. Test Data & Mocks

### Mock Data Factory

```typescript
// __fixtures__/factory.ts
import { faker } from '@faker-js/faker'

export const createUser = (overrides = {}) => ({
  id: faker.string.uuid(),
  address: `0x${faker.string.hexadecimal({ length: 40 })}`,
  email: faker.internet.email(),
  createdAt: faker.date.past(),
  ...overrides,
})

export const createTransaction = (overrides = {}) => ({
  hash: `0x${faker.string.hexadecimal({ length: 64 })}`,
  from: `0x${faker.string.hexadecimal({ length: 40 })}`,
  to: `0x${faker.string.hexadecimal({ length: 40 })}`,
  value: BigInt(faker.number.int({ min: 1, max: 1000000 })) * 10n ** 18n,
  status: 'confirmed',
  ...overrides,
})
```

### AI Response Fixtures

```typescript
// __fixtures__/ai-responses.ts
export const AI_RESPONSES = {
  ANALYSIS_SUCCESS: {
    summary: 'Market shows bullish trends',
    sentiment: 'positive',
    confidence: 0.87,
  },
  ANALYSIS_UNCERTAIN: {
    summary: 'Insufficient data',
    sentiment: 'neutral',
    confidence: 0.45,
  },
  ERROR_RATE_LIMITED: {
    ok: false,
    error: { code: 'RATE_LIMITED', retryAfter: 60 },
  },
}
```

---

## 7. CI Configuration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
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
      - run: pnpm test:unit
      - run: pnpm test:integration
      
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm exec playwright install
      - run: pnpm test:e2e
```

---

## Quick Reference

### 测试命令

```bash
pnpm test              # 运行所有测试
pnpm test:unit         # 仅单元测试
pnpm test:integration  # 仅集成测试
pnpm test:e2e          # 仅 E2E 测试
pnpm test:coverage     # 覆盖率报告
pnpm test:watch        # 监听模式
```

### 覆盖率目标 (OPC)

| 层级 | 目标 | 理由 |
|------|------|------|
| 工具函数 | 90%+ | 纯函数，容易测试 |
| Hooks | 70%+ | 核心逻辑 |
| API Routes | 80%+ | 关键入口 |
| 组件 | 50%+ | 视觉测试成本高 |
| E2E | 核心流程 | 不追求覆盖率 |

### 推荐库

```
vitest          - 单元/集成测试
@testing-library/react - React 组件测试
playwright      - E2E 测试
msw             - API mocking
@faker-js/faker - 测试数据生成
```
