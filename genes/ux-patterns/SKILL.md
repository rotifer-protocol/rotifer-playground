---
name: ux-patterns
description: 参数化UX交互模式库，根据emotionalTone和motionIntensity参数动态生成文案和动效。当用户提到"动效""状态反馈""文案""交互""微交互""用户体验"时使用。
---

# UX Patterns (参数化交互模式库)

**定位**: 确保交互体验有温度、有个性。

**核心目标**: 根据风格参数生成匹配的文案和动效，而非从预设中选择。

**依赖**: 接收 [brand-personality](../brand-personality/SKILL.md) 输出的 `emotionalTone` 和 `motionIntensity` 参数。

---

## Pre-Polish Checklist

应用 UX 模式前，逐项检查：

```
功能完整性：
- [ ] Loading: 有 Spinner/Skeleton/趣味加载?
- [ ] Success: 有 Toast/确认/庆祝动效?
- [ ] Error: 有温暖的错误提示?
- [ ] Empty: 有有趣的空状态?
- [ ] Animations: 状态切换有过渡?
- [ ] Hover: 可交互元素有悬停状态?
- [ ] Focus: 焦点状态清晰可见?

情感化检查（消除AI味）：
- [ ] 文案是否像真人说的话？
- [ ] 有没有至少一个惊喜时刻？
- [ ] 动效是否有个性（不只是 ease-out）？
- [ ] 空状态/错误状态是否让人感到被关心？
```

---

## 状态反馈模式

### 加载状态

| 场景 | 反馈方式 | 示例 |
|------|----------|------|
| 按钮提交 | 按钮内 Spinner + 文字 | "保存中..." |
| 页面加载 | 骨架屏 (Skeleton) | 灰色占位块 |
| 数据刷新 | 顶部进度条 / Spinner | NProgress 风格 |
| 后台操作 | Toast 提示 | "正在处理..." |

### 成功状态

| 场景 | 反馈方式 | 持续时间 |
|------|----------|---------|
| 表单提交 | Toast 成功提示 | 3秒自动消失 |
| 重要操作 | 弹窗确认 + 对勾动画 | 用户点击关闭 |
| 保存操作 | 轻量提示（顶部闪现） | 2秒自动消失 |

### 错误状态

| 场景 | 反馈方式 | 要求 |
|------|----------|------|
| 表单验证 | 输入框下方红色提示 | 即时反馈 |
| 网络错误 | Toast 错误提示 + 重试按钮 | 可操作 |
| 权限错误 | 弹窗说明 + 引导操作 | 说人话 |
| 严重错误 | 全屏错误页 + 联系方式 | 提供解决路径 |

### 空状态

| 场景 | 内容要素 |
|------|----------|
| 无数据 | 图标 + 说明文字 + 操作按钮 |
| 无搜索结果 | 提示词 + 搜索建议 |
| 无权限 | 说明 + 申请入口 |

---

## 参数化惊喜动效 (Delight Moments)

### 惊喜强度与参数关系

> 根据 `emotionalTone` 参数决定惊喜动效的强度

```typescript
type DelightLevel = 'none' | 'subtle' | 'moderate' | 'expressive';

function getDelightLevel(emotionalTone: number): DelightLevel {
  if (emotionalTone < 30) return 'none';       // 极简风格不使用惊喜动效
  if (emotionalTone < 55) return 'subtle';     // 轻微：对勾动画
  if (emotionalTone < 80) return 'moderate';   // 中等：弹性 + 高亮
  return 'expressive';                          // 强烈：撒花/emoji/庆祝
}
```

### 惊喜动效对照表

| emotionalTone | 级别 | 成功反馈 | 里程碑 | 首次完成 |
|---------------|------|----------|--------|----------|
| 0-29 | none | 无动效 | 无 | 无 |
| 30-54 | subtle | 对勾淡入 | 微弹高亮 | 轻微光效 |
| 55-79 | moderate | 对勾 + 弹性 | 徽章动画 | 光效 + 震动 |
| 80-100 | expressive | 撒花 + 对勾 | 烟花 + 徽章 | 全屏庆祝 |

### Delight 触发时机

| 时机 | subtle | moderate | expressive |
|------|--------|----------|------------|
| 首次完成任务 | 轻微高亮 | 光效动画 | 撒花/烟花 |
| 达成里程碑 | 微弹提示 | 徽章动画 | 徽章 + 震动 + emoji |
| 重要操作成功 | 对勾淡入 | 弹性对勾 | 对勾 + 撒花 |
| 解锁成就 | 轻微脉冲 | 星星效果 | 全屏光效 |

### Delight 动效代码

```tsx
// 撒花庆祝
function Confetti({ trigger }: { trigger: boolean }) {
  if (!trigger) return null
  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
      {[...Array(50)].map((_, i) => (
        <span
          key={i}
          className="absolute w-3 h-3 animate-confetti"
          style={{
            left: `${Math.random() * 100}%`,
            top: '-20px',
            backgroundColor: ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A855F7', '#FF00FF'][i % 5],
            animationDelay: `${Math.random() * 0.5}s`,
            animationDuration: `${1.5 + Math.random()}s`,
          }}
        />
      ))}
    </div>
  )
}

// 成功对勾（带弹性）
function SuccessCheck() {
  return (
    <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center animate-success-pop">
      <svg className="w-8 h-8 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <path className="animate-check-draw" d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

// 趣味加载（不同风格）
function FunLoader({ style = 'warm' }: { style: 'minimal' | 'warm' | 'playful' }) {
  const loaders = {
    minimal: <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />,
    warm: (
      <div className="flex flex-col items-center gap-3">
        <div className="text-3xl animate-bounce">☕</div>
        <p className="text-sm text-gray-500">马上就好...</p>
      </div>
    ),
    playful: (
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="w-3 h-3 bg-gradient-to-r from-pink-500 to-cyan-500 rounded-full animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    ),
  }
  return loaders[style]
}
```

### Delight 动画 CSS

```css
/* 撒花下落 */
@keyframes confetti {
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
}
.animate-confetti { animation: confetti 2s ease-out forwards; }

/* 成功弹出 */
@keyframes success-pop {
  0% { transform: scale(0); opacity: 0; }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); opacity: 1; }
}
.animate-success-pop { animation: success-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }

/* 对勾绘制 */
@keyframes check-draw {
  0% { stroke-dashoffset: 24; }
  100% { stroke-dashoffset: 0; }
}
.animate-check-draw {
  stroke-dasharray: 24;
  stroke-dashoffset: 24;
  animation: check-draw 0.4s ease-out 0.2s forwards;
}

/* 星星闪烁 */
@keyframes twinkle {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}
.animate-twinkle { animation: twinkle 1s ease-in-out infinite; }

/* 脉冲光环 */
@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 0.8; }
  100% { transform: scale(1.5); opacity: 0; }
}
.animate-pulse-ring { animation: pulse-ring 1s ease-out infinite; }
```

---

## 参数化动效系统

> 根据 `motionIntensity` 参数（0-100）生成匹配的动效参数

### 动效生成函数

```typescript
interface MotionParams {
  duration: number;      // 毫秒
  easing: string;        // CSS缓动函数
  staggerDelay: number;  // 错开延迟（毫秒）
  hoverScale: number;    // 悬停缩放比例
  clickScale: number;    // 点击缩放比例
}

function getMotionParams(motionIntensity: number): MotionParams {
  // 时长：80ms (克制) → 500ms (夸张)
  const duration = 80 + motionIntensity * 4.2;
  
  // 缓动函数随强度变化
  let easing: string;
  if (motionIntensity < 25) {
    easing = 'cubic-bezier(0.2, 0, 0, 1)';           // 快速线性
  } else if (motionIntensity < 50) {
    easing = 'cubic-bezier(0.16, 1, 0.3, 1)';        // 标准ease-out
  } else if (motionIntensity < 75) {
    easing = 'cubic-bezier(0.34, 1.56, 0.64, 1)';    // 轻微弹性
  } else {
    easing = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)'; // 明显弹性
  }
  
  // 错开延迟：30ms (克制) → 80ms (夸张)
  const staggerDelay = 30 + motionIntensity * 0.5;
  
  // 悬停缩放：1.0 (无) → 1.05 (明显)
  const hoverScale = 1 + (motionIntensity > 40 ? motionIntensity * 0.0005 : 0);
  
  // 点击缩放：0.98 (轻微) → 0.92 (明显)
  const clickScale = 0.98 - (motionIntensity * 0.0006);
  
  return { duration, easing, staggerDelay, hoverScale, clickScale };
}
```

### 动效参数对照表

| motionIntensity | 时长 | 缓动类型 | 特点 |
|-----------------|------|----------|------|
| 0-24 | 80-180ms | linear/snap | 瞬间响应，无多余 |
| 25-49 | 185-285ms | ease-out | 稳定，可预测 |
| 50-74 | 290-395ms | spring轻弹 | 柔和，让人放松 |
| 75-100 | 395-500ms | spring强弹 | 弹跳，有活力 |

### 缓动函数库

```css
:root {
  /* 根据 motionIntensity 选择 */
  
  /* 0-24: 快速响应 */
  --easing-snap: cubic-bezier(0.2, 0, 0, 1);
  
  /* 25-49: 标准流畅 */
  --easing-smooth: cubic-bezier(0.16, 1, 0.3, 1);
  
  /* 50-74: 轻微弹性 */
  --easing-spring-soft: cubic-bezier(0.34, 1.56, 0.64, 1);
  
  /* 75-100: 明显弹性 */
  --easing-spring-hard: cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
```

### 动效应用示例

```tsx
// 根据参数生成组件样式
function AnimatedButton({ motionIntensity }: { motionIntensity: number }) {
  const params = getMotionParams(motionIntensity);
  
  return (
    <button
      style={{
        transition: `all ${params.duration}ms ${params.easing}`,
      }}
      className={`
        hover:scale-[${params.hoverScale}]
        active:scale-[${params.clickScale}]
      `}
    >
      Click me
    </button>
  );
}

// 列表错开动画
function StaggerList({ items, motionIntensity }: Props) {
  const params = getMotionParams(motionIntensity);
  
  return (
    <ul>
      {items.map((item, i) => (
        <li
          key={item.id}
          style={{
            animation: `slide-up ${params.duration}ms ${params.easing}`,
            animationDelay: `${i * params.staggerDelay}ms`,
          }}
        >
          {item.content}
        </li>
      ))}
    </ul>
  );
}
```

### 动效场景适配

| 场景 | 低参数 (0-40) | 高参数 (60-100) |
|------|---------------|-----------------|
| 元素出现 | 快速淡入 | 淡入 + 弹性上移 |
| 弹窗出现 | 快速缩放 | 弹性缩放 + overshoot |
| 悬停 | 仅背景色变化 | 背景色 + 上浮 + 阴影 |
| 点击 | 轻微缩小(0.98) | 明显缩小(0.92) + 回弹 |
| 列表加载 | 快速全部出现 | 错开出现(stagger) |

### 错开延迟 (Stagger)

```tsx
// 列表项依次出现
function StaggerList({ items }: { items: any[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li
          key={item.id}
          className="animate-slide-up"
          style={{ animationDelay: `${i * 50}ms` }}
        >
          {item.content}
        </li>
      ))}
    </ul>
  )
}
```

### 基础动画代码

```css
@keyframes slide-up {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scale-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* 弹性缩放（温暖/活泼风格） */
@keyframes pop-in {
  0% { opacity: 0; transform: scale(0.8); }
  70% { transform: scale(1.05); }
  100% { opacity: 1; transform: scale(1); }
}

/* 抖动（错误反馈） */
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}

.animate-slide-up { animation: slide-up 0.3s var(--ease-out); }
.animate-fade-in { animation: fade-in 0.2s var(--ease-out); }
.animate-scale-in { animation: scale-in 0.2s var(--ease-out); }
.animate-pop-in { animation: pop-in 0.4s var(--spring-soft); }
.animate-shake { animation: shake 0.3s ease-in-out; }
```

---

## 微交互设计

### 按钮交互

```html
<!-- 完整交互状态 -->
<button class="px-4 py-2.5 bg-primary-500 text-white rounded-xl
               hover:bg-primary-600 
               active:bg-primary-700 active:scale-[0.98]
               focus:outline-none focus:ring-2 focus:ring-primary-500/20
               disabled:opacity-50 disabled:cursor-not-allowed
               transition-all duration-200">
  按钮
</button>
```

### 输入框交互

```html
<!-- 完整输入框状态 -->
<input class="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl
              text-gray-900 text-sm placeholder-gray-400
              hover:border-gray-300
              focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500
              disabled:bg-gray-100 disabled:cursor-not-allowed
              transition-all duration-200"
       placeholder="请输入...">
```

### 卡片交互

```html
<!-- 可点击卡片 -->
<div class="bg-white rounded-2xl border border-gray-100 p-6
            cursor-pointer
            hover:border-gray-200 hover:shadow-md
            active:scale-[0.99]
            transition-all duration-200">
  卡片内容
</div>
```

### 列表项交互

```html
<!-- 列表项悬停 -->
<div class="px-4 py-3 rounded-xl
            hover:bg-gray-50
            active:bg-gray-100
            transition-colors duration-150 cursor-pointer">
  列表项
</div>
```

---

## 参数化文案系统

> 根据 `emotionalTone` 参数（0-100）生成匹配的文案风格

### 文案生成函数

```typescript
type CopyStyle = 'minimal' | 'neutral' | 'friendly' | 'enthusiastic';

function getCopyStyle(emotionalTone: number): CopyStyle {
  if (emotionalTone < 25) return 'minimal';      // 0-24: 极简
  if (emotionalTone < 50) return 'neutral';      // 25-49: 中性
  if (emotionalTone < 75) return 'friendly';     // 50-74: 友好
  return 'enthusiastic';                          // 75-100: 热情
}

// 文案库：每个场景4个级别
const COPY_LIBRARY = {
  loading: {
    minimal: 'Loading',
    neutral: '加载中...',
    friendly: '马上就好...',
    enthusiastic: '稍等一下下~ ✨'
  },
  saveSuccess: {
    minimal: 'Saved',
    neutral: '已保存',
    friendly: '保存成功！',
    enthusiastic: '太棒了，搞定！🎉'
  },
  error: {
    minimal: 'Failed',
    neutral: '操作失败',
    friendly: '哎呀，出了点问题',
    enthusiastic: 'Oops！再试试？😅'
  },
  empty: {
    minimal: 'No items',
    neutral: '暂无数据',
    friendly: '这里空空如也，创建第一个吧',
    enthusiastic: '还没有内容呢，要不创建一个？✨'
  }
};

// 使用
function getCopy(scene: string, emotionalTone: number): string {
  const style = getCopyStyle(emotionalTone);
  return COPY_LIBRARY[scene][style];
}

// 示例：
// emotionalTone: 30 → getCopy('loading', 30) → "加载中..."
// emotionalTone: 70 → getCopy('loading', 70) → "马上就好..."
// emotionalTone: 90 → getCopy('loading', 90) → "稍等一下下~ ✨"
```

### 文案参数对照表

| emotionalTone | 风格 | 特点 | 示例(保存成功) |
|---------------|------|------|---------------|
| 0-24 | minimal | 极简、直接、无情绪 | "Saved" |
| 25-49 | neutral | 清晰、友好、不过分 | "已保存" |
| 50-74 | friendly | 亲切、鼓励、语气词 | "保存成功！" |
| 75-100 | enthusiastic | 热情、emoji、感叹 | "太棒了，搞定！🎉" |

### 完整文案库

#### 状态文案

| 场景 | minimal (0-24) | neutral (25-49) | friendly (50-74) | enthusiastic (75-100) |
|------|----------------|-----------------|------------------|----------------------|
| 加载中 | Loading | 加载中... | 马上就好... | 稍等一下下~ ✨ |
| 保存成功 | Saved | 已保存 | 保存成功！ | 太棒了，搞定！🎉 |
| 操作失败 | Failed | 操作失败 | 哎呀，出了点问题 | Oops！再试试？😅 |
| 空状态 | No items | 暂无数据 | 这里空空如也 | 还没有内容呢~ ✨ |
| 网络错误 | Offline | 网络连接失败 | 网络不太稳定 | 网络开小差了~ 🌐 |

#### 确认弹窗文案

| 场景 | minimal | neutral | friendly | enthusiastic |
|------|---------|---------|----------|--------------|
| 删除标题 | Delete? | 确认删除 | 确定要删除吗？ | 真的要删掉吗？🤔 |
| 删除描述 | Cannot undo | 此操作不可撤销 | 删除后无法恢复哦 | 删掉就找不回来啦！ |
| 确认按钮 | Delete | 确认删除 | 确定删除 | 删掉它！ |
| 取消按钮 | Cancel | 取消 | 再想想 | 我再想想 |

#### 欢迎/问候

| 场景 | minimal | neutral | friendly | enthusiastic |
|------|---------|---------|----------|--------------|
| 首次欢迎 | Welcome | 欢迎使用 | 欢迎来到这里！ | Hey！欢迎加入！🎊 |
| 回访问候 | — | 您好 | 欢迎回来！ | 好久不见！👋 |
| 完成引导 | Done | 设置完成 | 准备就绪！ | 搞定！准备起飞！🚀 |

### 文案通用原则

| 原则 | 说明 | 好例子 | 坏例子 |
|------|------|--------|--------|
| 像人说话 | 避免机器腔 | "哎呀，出了点问题" | "Error: Operation failed" |
| 避免责怪 | 不让用户感到愚蠢 | "请输入邮箱地址" | "邮箱格式错误！" |
| 提供出路 | 告诉用户怎么办 | "网络不稳定，点击重试" | "网络错误" |
| 适度幽默 | 根据参数调整程度 | emotionalTone > 70 时可用 | 低参数时避免 |

### Emoji 使用规则

```typescript
function shouldUseEmoji(emotionalTone: number): boolean {
  return emotionalTone >= 60;  // 60以上才使用emoji
}

function getEmojiIntensity(emotionalTone: number): 'none' | 'sparse' | 'frequent' {
  if (emotionalTone < 60) return 'none';
  if (emotionalTone < 80) return 'sparse';  // 偶尔使用
  return 'frequent';  // 大方使用
}
```

---

## 响应式交互

### 触摸优化

```css
/* 触摸设备优化 */
@media (hover: none) {
  /* 移除 hover 效果，避免粘滞 */
  .button:hover {
    background-color: initial;
  }
  
  /* 增大点击区域 */
  .touch-target {
    min-height: 44px;
    min-width: 44px;
  }
}
```

### 手势支持

| 手势 | 操作 |
|------|------|
| 点击 | 主要交互 |
| 长按 | 显示上下文菜单 |
| 左滑 | 删除/归档（列表项） |
| 下拉 | 刷新 |

---

## 可访问性

### 键盘导航

```html
<!-- 确保可聚焦 -->
<button tabindex="0">可聚焦按钮</button>

<!-- 跳过链接 -->
<a href="#main" class="sr-only focus:not-sr-only">跳到主内容</a>
```

### 焦点样式

```css
/* 清晰的焦点指示 */
:focus-visible {
  outline: 2px solid var(--primary-500);
  outline-offset: 2px;
}

/* 移除默认 outline，使用自定义样式 */
:focus {
  outline: none;
}
```

### 屏幕阅读器

```html
<!-- 仅屏幕阅读器可见 -->
<span class="sr-only">关闭弹窗</span>

<!-- 实时区域 -->
<div aria-live="polite" aria-atomic="true">
  <!-- 动态内容会被朗读 -->
</div>
```

---

## 必加 Classes

```tsx
"transition-all duration-200"  // 所有交互元素
"tabular-nums"                 // 数字对齐
"font-mono"                    // 地址/哈希/代码
"truncate"                     // 文本截断
"select-none"                  // 禁止选中（按钮等）
"cursor-pointer"               // 可点击元素
```

---

## 设计检查清单

应用 UX 模式后，最终检查：

```
视觉一致性：
- [ ] 圆角统一 (卡片 2xl，按钮 xl，输入框 xl)
- [ ] 间距遵循 8px 基准系统
- [ ] 字号阶梯清晰 (最多 3-4 种)
- [ ] 颜色使用克制 (主色 + 灰度)

交互体验：
- [ ] 所有可交互元素有 hover 状态
- [ ] 过渡动画平滑 (150-300ms)
- [ ] 焦点状态清晰可见
- [ ] 加载状态有反馈

留白与层次：
- [ ] 组件间有足够呼吸感
- [ ] 视觉层次不超过 3 级
- [ ] 使用边框代替重阴影
- [ ] 背景色使用浅灰而非纯白

文案：
- [ ] 文案简洁明了
- [ ] 错误提示说人话
- [ ] 空状态有引导
```

---

## 人性化反馈设计

### 超越"成功/失败"

传统反馈只告诉用户结果，人性化反馈关心用户的感受：

| 场景 | 传统反馈 | 人性化反馈 |
|------|---------|-----------|
| 保存成功 | "保存成功" | "已保存。你今天效率真高！" |
| 删除成功 | "删除成功" | "已删除。需要的话可以在回收站找回" |
| 上传完成 | "上传完成" | "上传完成！文件看起来不错 📄" |
| 首次操作 | "操作成功" | "太棒了，这是你的第一个项目！🎉" |
| 连续操作 | "保存成功" | "又搞定一个！保持这个节奏 💪" |

### 错误反馈的温度

```
冷冰冰（❌ 避免）：
- "Error 500: Internal Server Error"
- "操作失败"
- "请求超时"

有温度（✅ 推荐）：
- "服务器开了个小差，我们正在修复，请稍后再试"
- "哎呀，这个操作没成功，再试一次？"
- "网络有点慢，要不换个信号好的地方？"
```

### 空状态的温暖

```html
<!-- 冷冰冰 ❌ -->
<div class="text-center text-gray-500">
  暂无数据
</div>

<!-- 有温度 ✅ -->
<div class="text-center py-12">
  <div class="text-6xl mb-4">📝</div>
  <h3 class="text-lg font-medium text-gray-900 mb-2">还没有任何笔记</h3>
  <p class="text-sm text-gray-500 mb-6">
    写下你的第一个想法吧，好记性不如烂笔头
  </p>
  <button class="px-4 py-2 bg-primary text-white rounded-xl">
    创建笔记
  </button>
</div>
```

### 加载状态的趣味

```html
<!-- 无聊 ❌ -->
<div class="animate-spin w-8 h-8 border-2 border-gray-300 border-t-primary rounded-full"></div>

<!-- 有趣 ✅ -->
<div class="flex flex-col items-center gap-3">
  <div class="text-4xl animate-bounce">🚀</div>
  <p class="text-sm text-gray-500">正在准备精彩内容...</p>
</div>

<!-- 或者：进度文案变化 -->
<div class="text-center">
  <div class="animate-pulse text-sm text-gray-500">
    <!-- 随时间变化的文案 -->
    <!-- 0-2s: "加载中..." -->
    <!-- 2-5s: "快好了..." -->
    <!-- 5s+:  "稍微有点慢，再等等..." -->
  </div>
</div>
```

### 进度反馈的鼓励

```tsx
function ProgressFeedback({ progress }: { progress: number }) {
  const getMessage = () => {
    if (progress < 25) return "开始了！继续加油 💪"
    if (progress < 50) return "进展不错！"
    if (progress < 75) return "已经过半了！"
    if (progress < 100) return "马上就完成了！"
    return "太棒了，完成了！🎉"
  }
  
  return (
    <div>
      <div className="flex justify-between text-sm mb-2">
        <span>{getMessage()}</span>
        <span className="font-medium">{progress}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div 
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
```

---

## 设计检查清单（消除AI味）

最终检查，确保设计有灵魂：

```
文案检查：
- [ ] 文案像真人说的话吗？
- [ ] 错误提示是否让人感到被关心而非被责怪？
- [ ] 空状态是否温暖/有趣？
- [ ] 有没有在适当的地方使用 emoji？

动效检查：
- [ ] 动效是否有个性（不只是 ease-out 200ms）？
- [ ] 重要操作是否有惊喜反馈？
- [ ] 列表是否有错开加载效果？
- [ ] 成功状态是否有庆祝感？

情感检查：
- [ ] 首次用户有没有特别的欢迎？
- [ ] 里程碑时刻有没有庆祝？
- [ ] 等待时是否不无聊？
- [ ] 用户离开时有没有温暖的告别？
```

---

## 参数使用示例

### 完整工作流

```typescript
// 1. 从 brand-personality 获取参数
const styleParams = {
  emotionalTone: 65,
  motionIntensity: 55
};

// 2. 生成文案
const loadingCopy = getCopy('loading', styleParams.emotionalTone);
// → "马上就好..."

// 3. 生成动效参数
const motion = getMotionParams(styleParams.motionIntensity);
// → { duration: 311, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', ... }

// 4. 确定惊喜级别
const delightLevel = getDelightLevel(styleParams.emotionalTone);
// → 'moderate'

// 5. 应用到组件
<Button
  style={{ transition: `all ${motion.duration}ms ${motion.easing}` }}
  onClick={() => {
    // 操作成功后
    showToast(getCopy('saveSuccess', styleParams.emotionalTone));
    if (delightLevel !== 'none') showSuccessAnimation(delightLevel);
  }}
>
  {getCopy('save', styleParams.emotionalTone)}
</Button>
```

---

## 相关技能

- **brand-personality**: 提供 emotionalTone 和 motionIntensity 参数
- **design-tokens**: 提供圆角、颜色等视觉令牌
- **ui-components**: 使用本技能的文案和动效参数
- **uiux-designer**: 统一调度入口
