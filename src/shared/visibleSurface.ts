/**
 * A/C 可见表面的唯一判定（技术债收敛：此前「用户看到的是哪个界面」这一判定
 * 散落在 4 处、各写各的公式——titlebar 高亮、set-surface backstop、
 * devtools 路由、layoutViews——2026-08 的 A/C 倒挂死锁正是两处公式不一致
 * 的产物。现在 4 处全部走这一个纯函数，单测锁死组合矩阵）。
 *
 * 状态机背景（registry.ts 的设计意图，收敛不改变语义）：
 * - `panelSurface` 只回答「panelView 里装的是哪个前端」（'artify' | 'chooser'），
 *   A→C 切换后**故意保留** 'artify'——A UI 暖面板驻留、只隐藏，切回零重载。
 * - `activePanel` 决定「panelView 是否可见」（'comfy' = 显示 comfyView 画布，
 *   其余 key 显示 panelView）。
 * - 因此「用户实际看到的表面」必须由两者联合推导，任何单独一个都不完整。
 */
export type ComfySurface = 'artify' | 'comfy' | 'chooser'

export interface VisibleSurfaceInput {
  /** panelView 装载的前端（'artify' = A UI，'chooser' = 安装选择器）。 */
  panelSurface: 'artify' | 'chooser'
  /** 当前面板 key；'comfy' 表示 comfyView 画布可见。 */
  activePanel: string
}

/**
 * 推导用户实际看到的表面。
 * - `activePanel === 'comfy'` → 画布可见 → 'comfy'（即使 panelSurface 仍驻留
 *   'artify' 暖面板——这正是倒挂 bug 的场景）
 * - 否则 panelView 可见，显示 panelSurface 装载的界面 → panelSurface 值
 *   （install-less 窗口即 'chooser'）
 */
export function visibleSurfaceOf(input: VisibleSurfaceInput): ComfySurface {
  return input.activePanel === 'comfy' ? 'comfy' : input.panelSurface
}
