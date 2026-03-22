---
name: performance-optimizer
description: Optimize web performance including Core Web Vitals, bundle size, and runtime efficiency. Analyze and improve LCP, FID, CLS metrics. Use when optimizing performance, reducing bundle size, or when the user mentions slow, performance, loading, lighthouse, or web vitals.
---

# Performance Optimizer (性能优化师)

**Goal**: 提升 Web 应用性能，确保良好用户体验和 SEO 表现。

**核心指标**: Core Web Vitals (LCP, FID, CLS)

---

## 1. Core Web Vitals

### 指标标准

| 指标 | 含义 | Good | Needs Improvement | Poor |
|------|------|------|-------------------|------|
| **LCP** | 最大内容绘制 | < 2.5s | 2.5s - 4s | > 4s |
| **FID** | 首次输入延迟 | < 100ms | 100ms - 300ms | > 300ms |
| **CLS** | 累积布局偏移 | < 0.1 | 0.1 - 0.25 | > 0.25 |
| **INP** | 交互到下一次绘制 | < 200ms | 200ms - 500ms | > 500ms |

### 测量工具

```bash
# Lighthouse CLI
npx lighthouse https://example.com --view

# Web Vitals 库
pnpm add web-vitals
```

```typescript
// 监控 Web Vitals
import { onLCP, onFID, onCLS, onINP } from 'web-vitals'

onLCP(console.log)
onFID(console.log)
onCLS(console.log)
onINP(console.log)
```

---

## 2. Next.js Optimizations

### Image 优化

```tsx
// ❌ 未优化
<img src="/hero.png" />

// ✅ 使用 next/image
import Image from 'next/image'

<Image
  src="/hero.png"
  width={800}
  height={400}
  alt="Hero"
  priority  // LCP 图片加 priority
/>
```

### Font 优化

```typescript
// app/layout.tsx
import { Inter } from 'next/font/google'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',  // 避免 FOIT
  preload: true,
})

export default function Layout({ children }) {
  return (
    <html className={inter.className}>
      <body>{children}</body>
    </html>
  )
}
```

### Script 优化

```tsx
import Script from 'next/script'

// 非关键脚本延迟加载
<Script 
  src="https://analytics.com/script.js" 
  strategy="lazyOnload" 
/>

// 交互后加载
<Script 
  src="https://widget.com/chat.js" 
  strategy="afterInteractive" 
/>
```

### 动态导入

```tsx
import dynamic from 'next/dynamic'

// 客户端组件延迟加载
const HeavyChart = dynamic(() => import('./HeavyChart'), {
  loading: () => <Skeleton />,
  ssr: false,
})

// 条件导入
const AdminPanel = dynamic(() => import('./AdminPanel'), {
  loading: () => null,
})

function Page() {
  return (
    <>
      {isAdmin && <AdminPanel />}
    </>
  )
}
```

---

## 3. Bundle Size Optimization

### 分析 Bundle

```bash
# 安装分析工具
pnpm add -D @next/bundle-analyzer

# next.config.js
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
})

module.exports = withBundleAnalyzer({
  // config
})

# 运行分析
ANALYZE=true pnpm build
```

### Tree Shaking

```typescript
// ❌ 导入整个库
import _ from 'lodash'
_.debounce(fn, 300)

// ✅ 按需导入
import debounce from 'lodash/debounce'
debounce(fn, 300)

// ✅ 或使用 lodash-es
import { debounce } from 'lodash-es'
```

### 替换重型库

| 重型库 | 轻量替代 | 节省 |
|--------|----------|------|
| moment.js | date-fns / dayjs | ~95% |
| lodash | lodash-es + 按需导入 | ~90% |
| axios | fetch (原生) | 100% |
| uuid | nanoid | ~75% |

### 代码分割

```tsx
// 路由级分割 (Next.js 自动)
// app/dashboard/page.tsx → 单独 chunk

// 组件级分割
const Modal = dynamic(() => import('./Modal'))

// 条件加载
if (condition) {
  const module = await import('./heavy-module')
}
```

---

## 4. React Optimizations

### 避免不必要的重渲染

```tsx
// ❌ 每次渲染创建新对象
<Child style={{ color: 'red' }} />

// ✅ 使用 useMemo
const style = useMemo(() => ({ color: 'red' }), [])
<Child style={style} />
```

```tsx
// ❌ 每次渲染创建新函数
<Button onClick={() => handleClick(id)} />

// ✅ 使用 useCallback
const onClick = useCallback(() => handleClick(id), [id])
<Button onClick={onClick} />
```

### React.memo

```tsx
// 纯展示组件用 memo
const UserCard = memo(function UserCard({ user }) {
  return <div>{user.name}</div>
})

// 对比函数 (复杂 props)
const UserCard = memo(function UserCard({ user }) {
  return <div>{user.name}</div>
}, (prev, next) => prev.user.id === next.user.id)
```

### 虚拟化长列表

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

function VirtualList({ items }) {
  const parentRef = useRef(null)
  
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  })

  return (
    <div ref={parentRef} style={{ height: '400px', overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: 'absolute',
              top: virtualItem.start,
              height: virtualItem.size,
            }}
          >
            {items[virtualItem.index]}
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## 5. Network Optimizations

### 预加载关键资源

```tsx
// app/layout.tsx
export default function Layout() {
  return (
    <html>
      <head>
        <link rel="preconnect" href="https://api.openai.com" />
        <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
      </head>
    </html>
  )
}
```

### 缓存策略

```typescript
// API 缓存头
export async function GET() {
  return Response.json(data, {
    headers: {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  })
}

// Next.js fetch 缓存
const data = await fetch(url, {
  next: { revalidate: 60 },  // ISR
})

// React Query 缓存
const { data } = useQuery({
  queryKey: ['users'],
  queryFn: fetchUsers,
  staleTime: 60 * 1000,  // 1 分钟内不重新请求
})
```

### 压缩

```javascript
// next.config.js
module.exports = {
  compress: true,  // 默认开启
  
  // 或使用更高压缩率
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
}
```

---

## 6. CLS Prevention

### 图片尺寸

```tsx
// ❌ 无尺寸，导致布局偏移
<img src="/photo.jpg" />

// ✅ 明确尺寸
<Image src="/photo.jpg" width={400} height={300} alt="" />

// ✅ 占位容器
<div style={{ aspectRatio: '16/9' }}>
  <Image src="/photo.jpg" fill alt="" />
</div>
```

### 字体加载

```css
/* 使用 font-display: swap */
@font-face {
  font-family: 'Custom';
  src: url('/font.woff2') format('woff2');
  font-display: swap;
}
```

### 动态内容

```tsx
// ❌ 内容插入导致偏移
{isLoaded && <Banner />}

// ✅ 预留空间
<div style={{ minHeight: '100px' }}>
  {isLoaded ? <Banner /> : <Skeleton />}
</div>
```

---

## 7. Performance Monitoring

### Vercel Analytics

```tsx
// app/layout.tsx
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/next'

export default function Layout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
```

### 自定义监控

```typescript
// 发送到自己的分析服务
import { onLCP, onFID, onCLS } from 'web-vitals'

function sendToAnalytics(metric) {
  fetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(metric),
  })
}

onLCP(sendToAnalytics)
onFID(sendToAnalytics)
onCLS(sendToAnalytics)
```

---

## 8. Performance Checklist

```markdown
## 性能优化检查清单

### 加载性能 (LCP)
- [ ] 关键图片使用 next/image + priority
- [ ] 字体使用 next/font
- [ ] 首屏内容优先加载
- [ ] 使用 CDN

### 交互性能 (FID/INP)
- [ ] 减少主线程阻塞
- [ ] 使用 React.memo 避免重渲染
- [ ] 长列表虚拟化
- [ ] 代码分割

### 视觉稳定性 (CLS)
- [ ] 图片有明确尺寸
- [ ] 使用 font-display: swap
- [ ] 动态内容预留空间

### Bundle 优化
- [ ] 按需导入
- [ ] 动态导入非关键组件
- [ ] 替换重型库
- [ ] 分析 bundle 大小

### 网络优化
- [ ] 使用缓存策略
- [ ] 预连接关键域名
- [ ] 开启压缩
```

---

## Quick Reference

### Lighthouse 目标

```
Performance: > 90
Accessibility: > 90
Best Practices: > 90
SEO: > 90
```

### 常用命令

```bash
# 分析 bundle
ANALYZE=true pnpm build

# Lighthouse
npx lighthouse https://example.com

# Bundle 大小
npx bundlephobia lodash
```

### 性能预算

```
JS Bundle: < 200KB (gzipped)
First Load: < 100KB
LCP: < 2.5s
TTI: < 3.5s
```
