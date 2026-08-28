# ArtifyLab UI 重构方案 — 对齐 ComfyUI 桌面版设计语言

> 状态：**待审查**（过审前不动任何业务代码）
> 取证方式：ComfyUI 前端源码 CSS 变量直读（`comfyui_frontend_package/static/assets/main-*.css`）+ 双方真实界面截图 + 现有图标文件采样。

---

## 1. 取证结论：ComfyUI 桌面版的设计语言是什么

从 ComfyUI 前端源码提取的**真实设计令牌**（非目测）：

### 1.1 色板（dark-theme 为默认主题）

| 语义 | 变量 | 值 | 用途 |
|---|---|---|---|
| 基底背景 | `--color-charcoal-800` | `#171718` | 画布/主背景 |
| 面板表面 | `--color-charcoal-600` | `#262729` | 节点/面板/卡片 |
| 面板深部 | `--color-charcoal-700` | `#202121` | 节点头/次级面板 |
| hover 表面 | `--color-charcoal-400` | `#313235` | 悬停态 |
| hover 更亮 | `--color-charcoal-300` | `#3c3d42` | 选中/菜单高亮 |
| 细描边 | `--interface-stroke` | `#313235` (charcoal-400) | 1px 分隔线 |
| 强描边/选中 | `--node-stroke-selected` | `#ffffff` | 选中态用**白描边**而非变色 |
| 主文字 | `--text-primary` | `#ffffff` | |
| 次文字 | `--text-secondary` | `#a0a0a0` (smoke-700) | |
| 弱文字 | `--muted-foreground` | `#8a8a8a` (smoke-800) | |
| 执行/主色 | `--color-azure-600` | `#0b8ce9` | 运行按钮、执行中边框 |
| 主色 hover | `--color-azure-400` | `#31b9f4` | |
| 品牌点缀 | `--brand-yellow` | `#f0ff41` (electric-400) | 仅 logo/品牌标记 |
| 旧版菜单底 | `--comfy-menu-bg` | `#353535` | 兼容层 |

**关键观察**：
- **无渐变、无发光、无玻璃拟态**。层次全靠**表面色差**（#171718 → #202121 → #262729）+ 1px 细描边。
- 选中态语义 = **白描边** 或 **左侧色条**（`.side-bar-button-selected { border-left: 4px solid var(--p-button-text-primary-color) }`），不是换背景色。
- 主操作按钮 = azure 蓝填充 + 白字（截图中的「运行」按钮）。
- 品牌黄绿 `#f0ff41` **只出现在 logo**，不做界面功能色（克制）。

### 1.2 形状与字体

| 项 | 值 | 来源 |
|---|---|---|
| 控件圆角 | 4–6px | `--radius-sm: .25rem` `--radius-md: .375rem` |
| 卡片/面板圆角 | 8–10px | CSS 中 `border-radius:10px` 出现 8 次（最高频） |
| 弹窗圆角 | 14px | |
| 顶栏高度 | 40px | `--comfy-topbar-height: 2.5rem` |
| 侧栏宽 | 48px icon 条（浮动式）/ 56px 行高 | `--sidebar-default-floating-width: 48px` |
| 字体 | Inter | `font-family: Inter` |
| 描边宽 | 1px 为主，选中 4px 左条 | |

### 1.3 App 图标（Comfy 官方）

深紫黑底 `#211927`（ink）+ 电光黄 `#f0ff41` 单色 C 形，大圆角方形（≈22% 圆角）。**单色 + 深底 + 无渐变**。

### 1.4 Artify 现状 vs 目标的差距

| 维度 | Artify 现状 | ComfyUI 目标 |
|---|---|---|
| 主背景 | `#0f172a` 蓝黑 + 紫色渐变 hero（落地页） | `#171718` 中性炭黑，无渐变 |
| 强调色 | `#40e0d0` 青绿 + `glow` 发光动画 + 紫粉渐变文字 | `#0b8ce9` azure 蓝，无发光 |
| 层次手法 | `slate-900/60` 半透明玻璃卡 + 发光描边 | 实色表面分层 + 1px 描边 + 白描边选中 |
| 圆角 | `rounded-xl`（12px）混用 | 控件 6 / 卡片 10 / 弹窗 14 阶梯 |
| 图标库 | FontAwesome 彩色点缀 | 单色线性图标，随文字色 |
| 品牌区 | 绿蓝笔刷 favicon + 渐变字「Artify工坊」 | 深底 + 电光黄单色 mark |
| 字体 | 系统默认 | Inter |

---

## 2. 重构方案

### 2.1 设计令牌层（新增 `theme/comfy.css`，全应用唯一事实源）

```css
:root {
  /* surfaces — ComfyUI charcoal 阶梯直移 */
  --wb-bg-base: #171718;      /* 页面基底 */
  --wb-surface-deep: #202121; /* 次级面板/节点头 */
  --wb-surface: #262729;      /* 卡片/输入框 */
  --wb-surface-hover: #313235;
  --wb-surface-active: #3c3d42;
  /* strokes */
  --wb-stroke: #313235;       /* 1px 常规 */
  --wb-stroke-strong: #494a50;
  --wb-selected: #ffffff;     /* 选中白描边 */
  /* text */
  --wb-text: #ffffff;
  --wb-text-2: #a0a0a0;
  --wb-text-3: #8a8a8a;
  /* accent */
  --wb-accent: #0b8ce9;
  --wb-accent-hover: #31b9f4;
  --wb-danger: #f56c6c;
  --wb-success: #4ade80;
  /* brand（仅 logo） */
  --wb-brand: #f0ff41;
  --wb-ink: #211927;
  /* shape */
  --wb-r-ctrl: 6px;
  --wb-r-card: 10px;
  --wb-r-modal: 14px;
  --wb-topbar-h: 40px;
  --wb-font: 'Inter', -apple-system, 'PingFang SC', sans-serif;
}
```

**antd 对接**（`a-config-provider :theme`）：
`colorPrimary=#0b8ce9, colorBgContainer=#262729, colorBgElevated=#313235, colorBorder=#313235, colorBorderSecondary=#313235, colorText=#fff, colorTextSecondary=#a0a0a0, borderRadius=6, fontFamily=Inter` — 一次映射，全应用 antd 组件自动换肤。

**清理项**：`tech-blue/purple/pink/glow/float` 等 tailwind 扩展与 `bg-tech-dark` 渐变 hero 退役（保留类名做兼容别名过渡，二期删除）。

### 2.2 全局壳（三处）

| 区域 | 改造 |
|---|---|
| 顶栏 | 高 40px，`#171718` 底 + 底部 1px `--wb-stroke`；导航改 Comfy 式 tab 文字（active 白字+底部 2px azure 条，inactive `#a0a0a0`）；logo 电光黄 A-mark + 白字「Artify工坊」（去渐变） |
| 落地页 | 渐变 hero → 炭黑实底 + 居中品牌区（同 demo 图）；或直接跳过落地页进应用中心（二期可议） |
| 浮动按钮组 | 玻璃拟态 → `#262729` 实色方卡 + 1px 描边 |

### 2.3 应用中心（`/`）

- 页头：「应用中心」白字 + 操作右置（Comfy 式工具条按钮：`#262729` 底 6px 圆角）
- 应用卡：`#202121` 实色卡 + 1px 描边 + 10px 圆角；hover → 表面 `#262729` + 白描边（选中语义）；**卡内不发光不加渐变**
- 在线状态点、分类 chip：azure 系
- 空态：单色图标 + `#a0a0a0` 文案

### 2.4 工作台（`/workbench`）——功能零改动，纯换肤

| 组件 | 改造 |
|---|---|
| 会话侧栏 | `#171718` 底；「新建会话」= azure 填充按钮（对齐 Comfy「运行」钮）；会话项 hover `#262729`，选中 = 左侧 3px azure 条 + 白字（对齐 `.side-bar-button-selected` 语义）；搜索框 `#262729` 底 6px 圆角 |
| 预设/意图 chip | 描边 pill（`--wb-stroke`），active 白描边 |
| 对话主区 | `#171718` 底；消息气泡改为 Comfy 节点式卡片：`#202121` 底 + 1px 描边 + 10px 圆角，用户消息左侧 3px azure 条，AI 消息左侧 3px `#494a50` 条 |
| Composer | `#202121` 卡 + 1px 描边 + 10px 圆角，聚焦描边 azure；发送钮 azure 方形 |
| 产物栏 | `#202121` 面板 + 1px 描边，缩略图 8px 圆角 |
| Markdown/代码块 | 代码块 `#111` 底 + `#313235` 描边 |

### 2.5 Artify 图标 — Comfy 风格化

**规格**：圆角方形深底 `#211927`（22% 圆角）+ 电光黄 `#f0ff41` **单色 A 形**（粗几何笔画，与 Comfy C 形同族）：

```
┌──────────────┐
│   ████████   │   A-mark：实心三角骨架 + 横杠缺口，
│  ██░░░░░░██  │   笔画宽 ≈ 高度 22%，与 Comfy C 同粗细节奏
│ ██░░████░░██ │
│ ███░░░░░███  │
│ ██░░░░░░░██  │
└──────────────┘
```

三个落地物：
1. **App/dock icon**（`resources/icon.png` 系列全套尺寸）— 深底 + 黄 A
2. **应用内 logo**（顶栏/关于页）— 黄 A-mark + 白字「Artify工坊」，替换绿蓝笔刷 favicon
3. **favicon.ico / favicon_rmbg.png** — 同 mark 缩小版

> 注：`resources/icon.png` 现在就是 Comfy 官方 C 形（fork 遗留）。换成 A 形既保留 Comfy 风格基因（同底色同单色同笔画语言）又标识 Artify 自身。

### 2.6 实施顺序（过审后）

1. `theme/comfy.css` 令牌 + antd theme 映射（一处改动全局生效）
2. AppHeader/落地页/浮动按钮组去渐变化
3. 应用中心卡片换肤
4. 工作台三栏换肤（不改任何逻辑/接口/store）
5. 图标三件套生成与替换
6. `tech-*` 类名清理（兼容期一版）

---

## 3. Demo

`demo/comfy-style-demo.html` — 单文件静态 demo，含应用中心 + 工作台两页（顶部切换），纯展示交互不含业务。已按上述令牌实现，供直接比对审查。
