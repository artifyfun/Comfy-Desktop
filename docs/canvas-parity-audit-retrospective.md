# 画布模块对标审计与补齐（P0–P3）复盘

> 弧线：2024-12 对比开源无限画布（参考项目 /tmp/infinite-canvas，tldraw/excalidraw 系
> 架构）逐能力审计 → 产出 TOP5 差距 + P0/P1/P2/P3 backlog → 全部落地。
> 基线 `a5951f7e^`（P0 批前）→ 收官 `88adc637`。累计 13 个提交，
> `packages/frontend/src` +1733/−71，测试 261 → 290。

## 一、审计方法

1. 逐文件读参考项目源码（画布引擎/渲染层/交互层/持久化），
   与本项目 `packages/frontend/src/views/canvas/` 逐能力对照。
2. 差距按「用户可感知」排序：先修正确性（P0），再补能力（P1/P2），
   最后性能与打磨（P3）。
3. 每项落地后浏览器实测（Electron CDP 合成事件驱动真实 DOM/Konva），
   commit message 附实测数据。**不实测不提交**。

## 二、批次与提交

### P0 正确性快修（a5951f7e，单提交五项）

| 问题 | 根因 | 修法 |
|---|---|---|
| 拖动节点连线滞后一拍 | 数据 dragend 才写回 | dragmove 实时写回 `o.x/o.y`（e8c7cdaf 先行） |
| 便签南向角拖高度坍塌 | 南向判定符号错 | 纯函数 freeResizeRect 修（aac3b1ce 先行） |
| 4MB localStorage 警告 | persist 全量存 | 配额检测 + 溢出清理 |
| 生图结果不回填画布 | 回填链路断 | 结果落对象 + 缩略 |
| 小地图拖动失灵 | 事件坐标换算 | 视口换算修正 |
| i18n 补漏 | 键缺失 | zh/en 补齐 |

### P1 能力补齐（三提交）

1. **图层树面板**（`99c8aceb` 前置）：可见性/锁定/重命名/重排/删除，
   selection 双向绑定。
2. **多选对齐/等距分布 + z 层级四向**（`8c36d4ec`）：engine 纯函数
   `alignObjects/distributeObjects/zShiftObjects` + 右键菜单六向对齐 +
   两向分布 + 四向 z 序；快照式历史天然一步 undo。
3. **悬浮工具栏显隐自定义**（`a9a26f2b`）：用户可勾选工具栏按钮，
   持久化 localStorage。

### P2 体验闭环（五提交）

1. **素材库面板**（`5a2bfcc6`）：上传/拖入导入、160px 缩略 + 640px
   persist 双 dataURL、配额淘汰最旧、拖入画布（自定义 MIME 优先于
   文件分支）。
2. **节点级导出 ZIP**（`51f9942a`）：选中图片打包 jszip；文件名 prompt
   净化 24 字符 + mention 剥离 + 去重后缀。
3. **批量图片网格分组**（`f826f268`）：选中 image 统一格宽重排 +
   自动成组（跨组先迁出再入新组）。
4. **视口裁剪**（`1b377e21`）：`visibleIds` 纯函数按视口世界包围盒 +
   240px margin 求可见集；例外集 = 选中 ∪ 悬停 ∪ 连线端点闭包；
   六类渲染 computed 统一 `withCull`。**1000 物件常规视口 draw
   317ms → 3.2ms（约 100×）**。
5. **App 参数预设**（`af53731e`）：面板保存/应用/删除命名预设，
   localStorage 按 appId 分桶，快照只收非空字段。

### 打磨（两提交）

- **embed 死按钮**（`c6c30ca1`）：workbench 产物面板开关在 embed 模式
  渲染但无功能，`v-if="!isNarrow"` 隐藏。
- **面板↔画布悬停联动**（`b7da50e7`）：hoverFromPanel 并入统一高亮链
  （isHighlightedOf/highlightStroke），被裁物件悬停例外渲染。

### P3 性能与 undo 语义（两提交）

1. **LOD 全览优化**（`ffc342bb`）：`lodTextVisible`（scale<0.3 隐文本
   排版）/`lodImageVisible`（<0.15 隐位图）纯函数；八处文本 config +
   句柄层整组 LOD。**全览 875 可见 draw 317→138ms（−56%）**；
   scale 回 1 文本/句柄全恢复。
2. **连续微调 undo 合并**（`88adc637`）：审计确认批量操作快照历史
   天然 1 步回退（伪需求）；真实缺口在同属性连续微调——字号 ±1、
   z 层移一层补 800ms 同向合并窗口（换对象/方向/过期新起条）。

## 三、关键工程决策（沉淀）

1. **Konva 约束**：v-if/动态 listening 在 v-group 上会破坏 hit graph
   ——裁剪走 computed 列表（`withCull`）、LOD 走 config `visible:false`
   （Konva patch 路径）、句柄常驻渲染 + hitFunc 动态开闭热区。
   详见 index.vue 模板注释与 `handleConfig` 注释。
2. **裁剪例外集**：selection ∪ hover ∪ hoverFromPanel ∪ 连线端点闭包
   （一端可见另一端保留，线不断头）。新增渲染层一律走 `withCull`，
   例外只在 `cullIds` computed 集中加。
3. **快照式 undo**：beforeChange 压完整快照，批量操作天然合并——
   不需要 per-op diff。微调合并只需在调用侧加时间窗（不改引擎）。
4. **纯函数下沉**：所有几何/布局/裁剪/LOD 逻辑在 engine.js 纯函数 +
   单测（happy-dom 无 2D canvas，canvas-DOM 逻辑不进单测）；DOM/Konva
   行为验证走 CDP 合成事件（AGENTS.md 约定，零 flaky）。
5. **测试基线纪律**：eslint 16（canvas/index.vue 历史存量）/ root
   0 err 42 warn；每提交不回归基线。
6. **dev 产物新鲜度**：任何源码改动（含 prettier --write）后必须
   `npm run copy:dist` 再重启 dev，否则拒启（前端部署产物过期）。
   pnpm --filter 会静默跑旧产物，一律 `cd packages/frontend && npm run build`。

## 四、遗留与后续方向

- **节点 caching**（暂缓）：全览场景再砍需 Konva `cache()` 位图化，
  收益/复杂度比低（缓存失效：拖动/编辑需 dirty），不动。
- **帧率采样**（方法学）：Electron 后台窗口 rAF 节流，CDP 不能 await
  rAF——用 layer.draw/drawHit 计时代理帧预算（30 次均值）。
- **hoverFromPanel→工具栏**：面板悬停不弹悬浮工具栏（正确行为，
  refBarHover/hoverNodeId 优先级已处理），无需改。

## 五、数字总账

| 指标 | 前 | 后 |
|---|---|---|
| 单测 | 261 | 290（+29） |
| 1000 物件常规视口 draw | ~317ms | 3.2ms |
| 1000 物件全览 draw | 317ms | 138ms |
| 对齐/网格等批量 undo | — | 1 步（实测确认） |
| 字号 5 连调 undo | 5 步 | 1 步 |
| src 净变更 | — | +1733/−71（10 文件） |
