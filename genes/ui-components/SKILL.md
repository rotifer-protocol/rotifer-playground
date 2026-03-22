---
name: ui-components
description: 参数化UI组件库，根据风格参数动态生成按钮、输入框、卡片等组件样式。当用户提到"按钮""输入框""卡片""表格""弹窗""导航"等组件时使用。
---

# UI Components (参数化组件库)

**定位**: 根据风格参数动态生成组件样式，而非从固定变体中选择。

**依赖**: 
- [brand-personality](../brand-personality/SKILL.md) - 提供风格维度参数
- [design-tokens](../design-tokens/SKILL.md) - 提供CSS变量
- [ux-patterns](../ux-patterns/SKILL.md) - 提供文案和动效参数

---

## 参数化组件生成

### 核心思路

```
输入: 风格参数 (borderRadius, motionIntensity, contrast, colors...)
  ↓
处理: 参数映射函数
  ↓
输出: 组件CSS类/样式
```

### 参数到样式的映射

```typescript
interface StyleParams {
  borderRadius: number;      // 0-100 → 圆角
  motionIntensity: number;   // 0-100 → 动效
  contrast: number;          // 0-100 → 阴影/边框强度
  density: number;           // 0-100 → 间距
  colors: {
    primary: string;
    secondary?: string;
  };
}

function generateButtonStyles(params: StyleParams) {
  const radius = Math.round(params.borderRadius * 0.32); // 0-32px
  const duration = 80 + params.motionIntensity * 4.2;
  const shadowOpacity = 0.05 + params.contrast * 0.002;
  const padding = params.density > 50 ? 'px-6 py-3' : 'px-4 py-2.5';
  
  return {
    base: `
      ${padding} 
      bg-[${params.colors.primary}] text-white 
      text-sm font-medium
      rounded-[${radius}px]
      transition-all duration-[${Math.round(duration)}ms]
    `,
    hover: params.contrast > 50 
      ? `hover:shadow-lg hover:-translate-y-0.5` 
      : `hover:brightness-110`,
    active: params.motionIntensity > 60 
      ? `active:scale-95` 
      : `active:brightness-95`
  };
}
```

---

## 按钮 (Button)

### 参数化生成

```typescript
function Button({ params, children }: { params: StyleParams; children: React.ReactNode }) {
  const radius = Math.round(params.borderRadius * 0.32);
  const duration = 80 + params.motionIntensity * 4.2;
  
  // 根据参数决定样式特性
  const useGradient = params.contrast > 70;
  const useShadow = params.contrast > 40;
  const useScale = params.motionIntensity > 50;
  
  return (
    <button
      className={`
        px-${params.density > 50 ? 6 : 4} py-${params.density > 50 ? 3 : 2.5}
        text-sm font-medium text-white
        rounded-[${radius}px]
        transition-all duration-[${Math.round(duration)}ms]
        ${useGradient 
          ? 'bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-secondary)]' 
          : 'bg-[var(--color-primary)]'}
        ${useShadow ? 'shadow-md hover:shadow-lg' : ''}
        ${useScale ? 'hover:scale-[1.02] active:scale-95' : 'hover:brightness-110'}
      `}
    >
      {children}
    </button>
  );
}
```

### 参数效果对照

| 参数组合 | 效果 |
|---------|------|
| borderRadius: 15, motionIntensity: 15 | 小圆角，快速过渡，无缩放 |
| borderRadius: 70, motionIntensity: 55 | 大圆角，中等过渡，轻微缩放 |
| borderRadius: 85, motionIntensity: 80, contrast: 80 | 药丸形，弹性动效，渐变+阴影 |

### 示例输出

```html
<!-- borderRadius: 20, motionIntensity: 30, contrast: 40 -->
<button class="px-4 py-2.5 bg-[var(--color-primary)] text-white text-sm font-medium
               rounded-[6px] transition-all duration-[206ms]
               hover:brightness-110">
  提交
</button>

<!-- borderRadius: 70, motionIntensity: 60, contrast: 60 -->
<button class="px-6 py-3 bg-[var(--color-primary)] text-white text-sm font-medium
               rounded-[22px] shadow-md transition-all duration-[332ms]
               hover:shadow-lg hover:scale-[1.02] active:scale-95">
  开始使用
</button>

<!-- borderRadius: 90, motionIntensity: 85, contrast: 80 -->
<button class="px-6 py-3 text-white text-sm font-semibold
               rounded-full shadow-lg
               bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-secondary)]
               transition-all duration-[437ms]
               hover:shadow-xl hover:scale-105 active:scale-95">
  Let's Go!
</button>
```

---

## 卡片 (Card)

### 参数化生成

```typescript
function generateCardStyles(params: StyleParams) {
  const radius = Math.round(params.borderRadius * 0.32) + 4; // 卡片圆角稍大
  const padding = 16 + params.density * 0.16; // 16-32px
  const duration = 80 + params.motionIntensity * 4.2;
  
  // 边框 vs 阴影
  const useShadow = params.contrast > 50;
  const borderStyle = useShadow 
    ? 'border-transparent shadow-md' 
    : 'border border-gray-100';
  
  // 悬停效果
  const hoverEffect = params.motionIntensity > 40
    ? 'hover:shadow-lg hover:-translate-y-1'
    : 'hover:border-gray-200';
  
  return {
    container: `
      bg-white rounded-[${radius}px] p-[${Math.round(padding)}px]
      ${borderStyle}
      transition-all duration-[${Math.round(duration)}ms]
      ${hoverEffect}
    `,
    title: `text-lg font-semibold text-gray-900 mb-2`,
    description: `text-sm text-gray-500 leading-relaxed`
  };
}
```

### 示例输出

```html
<!-- 低参数: borderRadius: 25, contrast: 35 -->
<div class="bg-white rounded-[12px] p-5 border border-gray-100
            transition-all duration-[185ms]
            hover:border-gray-200">
  <h3 class="text-lg font-semibold text-gray-900 mb-2">标题</h3>
  <p class="text-sm text-gray-500">描述内容</p>
</div>

<!-- 高参数: borderRadius: 75, contrast: 65, motionIntensity: 60 -->
<div class="bg-white rounded-[28px] p-7 shadow-md
            transition-all duration-[332ms]
            hover:shadow-lg hover:-translate-y-1">
  <h3 class="text-lg font-semibold text-gray-900 mb-2">温暖标题</h3>
  <p class="text-sm text-gray-500 leading-relaxed">温暖的描述文字</p>
</div>
```

---

## 输入框 (Input)

### 参数化生成

```typescript
function generateInputStyles(params: StyleParams) {
  const radius = Math.round(params.borderRadius * 0.28); // 输入框圆角稍小
  const duration = 80 + params.motionIntensity * 4.2;
  
  // 背景样式
  const bgStyle = params.contrast < 40 
    ? 'bg-transparent border-b border-gray-300' // 下划线风格
    : 'bg-gray-50 border border-gray-200';       // 常规风格
  
  return `
    w-full px-4 py-2.5 text-sm text-gray-900
    ${bgStyle}
    rounded-[${radius}px]
    placeholder-gray-400
    transition-all duration-[${Math.round(duration)}ms]
    focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 
    focus:border-[var(--color-primary)]
  `;
}
```

### 示例输出

```html
<!-- 低对比度/极简: borderRadius: 10, contrast: 25 -->
<input class="w-full px-4 py-2.5 text-sm text-gray-900
              bg-transparent border-b border-gray-300
              rounded-[3px] placeholder-gray-400
              transition-all duration-[122ms]
              focus:outline-none focus:border-[var(--color-primary)]"
       placeholder="请输入...">

<!-- 高参数: borderRadius: 65, contrast: 55 -->
<input class="w-full px-4 py-2.5 text-sm text-gray-900
              bg-gray-50 border border-gray-200
              rounded-[18px] placeholder-gray-400
              transition-all duration-[311ms]
              focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 
              focus:border-[var(--color-primary)]"
       placeholder="请输入...">
```

---

## 弹窗 (Modal)

### 参数化生成

```typescript
function generateModalStyles(params: StyleParams) {
  const radius = Math.round(params.borderRadius * 0.32) + 8; // 弹窗圆角更大
  const duration = 80 + params.motionIntensity * 4.2;
  const padding = 20 + params.density * 0.12;
  
  // 入场动画
  const animation = params.motionIntensity > 60
    ? 'animate-pop-in'  // 弹性缩放
    : 'animate-fade-in'; // 简单淡入
  
  return {
    overlay: `fixed inset-0 bg-black/30 backdrop-blur-sm z-40`,
    container: `
      fixed inset-0 flex items-center justify-center z-50 p-4
    `,
    content: `
      bg-white rounded-[${radius}px] shadow-xl w-full max-w-md
      ${animation}
    `,
    header: `px-${Math.round(padding / 4)} py-4 border-b border-gray-100`,
    body: `px-${Math.round(padding / 4)} py-4`,
    footer: `px-${Math.round(padding / 4)} py-4 bg-gray-50 flex justify-end gap-3 
             rounded-b-[${radius}px]`
  };
}
```

---

## 导航 (Navigation)

### 侧边栏参数化

```typescript
function generateSidebarStyles(params: StyleParams) {
  const itemRadius = Math.round(params.borderRadius * 0.24);
  const duration = 80 + params.motionIntensity * 4.2;
  
  return {
    container: `w-64 h-screen bg-white border-r border-gray-100 p-4`,
    navItem: `
      flex items-center gap-3 px-3 py-2.5
      text-gray-600 text-sm
      rounded-[${itemRadius}px]
      transition-colors duration-[${Math.round(duration)}ms]
      hover:bg-gray-50
    `,
    navItemActive: `
      flex items-center gap-3 px-3 py-2.5
      text-[var(--color-primary)] font-medium text-sm
      rounded-[${itemRadius}px]
      bg-[var(--color-primary)]/5
    `
  };
}
```

---

## 表格 (Table)

### 参数化生成

```typescript
function generateTableStyles(params: StyleParams) {
  const containerRadius = Math.round(params.borderRadius * 0.32);
  const duration = 80 + params.motionIntensity * 4.2;
  
  return {
    container: `bg-white rounded-[${containerRadius}px] border border-gray-100 overflow-hidden`,
    header: `bg-gray-50 border-b border-gray-100`,
    headerCell: `px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider`,
    body: `divide-y divide-gray-50`,
    row: `hover:bg-gray-50 transition-colors duration-[${Math.round(duration * 0.5)}ms]`,
    cell: `px-6 py-4 text-sm text-gray-900`
  };
}
```

---

## 反馈组件

### Toast 参数化

```typescript
function generateToastStyles(params: StyleParams) {
  const radius = Math.round(params.borderRadius * 0.28);
  const duration = 80 + params.motionIntensity * 4.2;
  
  // 入场动画
  const animation = params.motionIntensity > 50
    ? 'animate-slide-up'
    : 'animate-fade-in';
  
  return `
    flex items-center gap-3 px-4 py-3
    bg-white border border-gray-100 
    rounded-[${radius}px] shadow-lg
    ${animation}
  `;
}
```

### 空状态参数化

```typescript
function generateEmptyStateStyles(params: StyleParams, emotionalTone: number) {
  // 根据 emotionalTone 决定是否使用 emoji/插画
  const useEmoji = emotionalTone >= 60;
  const iconSize = emotionalTone > 70 ? 'text-6xl' : 'text-4xl';
  
  return {
    container: `py-16 text-center`,
    icon: useEmoji ? iconSize : 'w-16 h-16 text-gray-300',
    title: `text-lg font-medium text-gray-900 mb-2`,
    description: `text-sm text-gray-500 mb-6`,
    action: `px-4 py-2 bg-[var(--color-primary)] text-white rounded-[var(--radius-md)]`
  };
}
```

---

## 预设快捷入口

预设只是预定义的参数组合：

```typescript
const COMPONENT_PRESETS = {
  minimal: {
    borderRadius: 15, motionIntensity: 15, contrast: 35, density: 40
  },
  warm: {
    borderRadius: 70, motionIntensity: 55, contrast: 45, density: 65
  },
  playful: {
    borderRadius: 85, motionIntensity: 80, contrast: 70, density: 55
  },
  professional: {
    borderRadius: 25, motionIntensity: 35, contrast: 55, density: 45
  },
  bold: {
    borderRadius: 50, motionIntensity: 90, contrast: 95, density: 50
  }
};

// 使用预设
const warmButton = generateButtonStyles({
  ...COMPONENT_PRESETS.warm,
  colors: { primary: '#E07A5F' }
});
```

---

## 人性化细节

### 有机形状（高 borderRadius + 微调）

```css
/* 当 borderRadius > 70 时，可选择性使用不对称圆角 */
.organic-card {
  border-radius: 24px 20px 28px 22px;
}

/* 或微妙倾斜 */
.playful-tilt {
  transform: rotate(-0.5deg);
}
.playful-tilt:hover {
  transform: rotate(0.5deg);
}
```

### 渐变与光效（高 contrast）

```html
<!-- contrast > 70 时可使用 -->
<div class="relative overflow-hidden">
  <div class="absolute -top-40 -right-40 w-80 h-80 
              bg-[var(--color-primary)]/10 rounded-full blur-3xl"></div>
  <!-- 内容 -->
</div>
```

---

## 使用工作流

```typescript
// 1. 获取风格参数
const params = getStyleParams(); // 从 brand-personality 获取

// 2. 生成组件样式
const buttonStyles = generateButtonStyles(params);
const cardStyles = generateCardStyles(params);
const inputStyles = generateInputStyles(params);

// 3. 应用到组件
<button className={buttonStyles.base + buttonStyles.hover}>
  提交
</button>

<div className={cardStyles.container}>
  <h3 className={cardStyles.title}>标题</h3>
  <p className={cardStyles.description}>描述</p>
</div>
```

---

## 相关技能

- **brand-personality**: 提供风格维度参数
- **design-tokens**: 提供CSS变量（圆角、颜色、动效）
- **ux-patterns**: 提供文案和动效参数
- **uiux-designer**: 统一调度入口
