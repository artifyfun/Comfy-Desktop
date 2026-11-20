// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
import { CANVAS_BRIDGE } from './card_bridge.js'
import { pushCanvasDigest } from './digest.js'
export function bindComfyApiEvents() {
  const api = (window.app || {}).api
  if (!api || typeof api.addEventListener !== 'function' || CANVAS_BRIDGE.apiBound) return
  CANVAS_BRIDGE.apiBound = true
  const onExecEvent = () => pushCanvasDigest()
  // 执行生命周期：running→idle 的流转都会改变 queue 摘要。
  // 注意：只对本页面提交的 prompt 有效（execution 事件按 clientId 定向）；
  // express 服务端提交的任务收不到这些事件——靠 status + 密集轮询兜底。
  for (const ev of [
    'execution_start',
    'executing',
    'execution_error',
    'execution_success',
    'execution_cached',
    'progress',
  ]) {
    try {
      api.addEventListener(ev, onExecEvent)
    } catch (_e) {
      /* 个别事件名随版本漂移，跳过 */
    }
  }
  // status 事件是广播的（队列长度变化即触发），且 payload 自带
  // queue_remaining——这是外部提交（服务端编排）唯一的实时信号
  try {
    api.addEventListener('status', (ev) => {
      const detail = ev && ev.detail
      const remaining = detail && (detail.queue_remaining ?? detail.exec_info?.queue_remaining)
      if (typeof remaining === 'number') {
        CANVAS_BRIDGE.lastQueueRemaining = remaining
      }
      pushCanvasDigest()
    })
  } catch (_e) {
    /* status 事件不可用时纯靠轮询 */
  }
  // 300ms 节流：progress 事件高频，摘要重算走节流去重即可
  let pending = false
  api.addEventListener('progress', () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      pushCanvasDigest()
    }, 300)
  })
}

/**
 * 画布变更兜底轮询 + 执行窗口密集采样。
 * 官方 execution 事件只回给提交 clientId 的页面（express 编排的任务
 * 收不到），status 广播 + 轮询是外部任务的唯一感知来源：
 *  - 空闲：2s 周期
 *  - 队列有活（lastQueueRemaining>0 或最近读到 running/pending>0）：
 *    400ms 密集采样，保证跑完 400ms 内感知到
 */
export function startCanvasPoll() {
  if (CANVAS_BRIDGE.pollTimer) return
  CANVAS_BRIDGE.pollTimer = setInterval(() => {
    const active =
      (CANVAS_BRIDGE.lastQueueRemaining || 0) > 0 || CANVAS_BRIDGE.lastDigestQueueActive === true
    pushCanvasDigest()
    // 动态周期：active 时切到 400ms，空闲回 2s（重设 interval）
    const wantDelay = active ? 400 : 2000
    if (wantDelay !== CANVAS_BRIDGE.pollDelay) {
      clearInterval(CANVAS_BRIDGE.pollTimer)
      CANVAS_BRIDGE.pollDelay = wantDelay
      CANVAS_BRIDGE.pollTimer = null
      startCanvasPoll()
    }
  }, CANVAS_BRIDGE.pollDelay || 2000)
}

/**
 * 侧栏宽度治理（「拉到最大后收不回来」修复）：
 * 官方侧栏是 PrimeVue Splitter（.side-bar-panel / .p-splitter-gutter），
 * 拉满后 gutter 贴住窗口右缘（命中区只剩 ~4px 且紧邻窗口 resize 热区），
 * 真实鼠标极难抓住 → 表现为「收不回来」。治理三件事：
 *  1) 钳制最大宽度：flex-basis 上限 45%（保留画布可用区；官方默认 ~20%，正常拖拽不受影响）
 *  2) 加宽 gutter 命中区（4px → 视觉不变、热区 ~14px），贴边也好抓
 *  3) 双击 gutter 一键复位 20%（卡住时的逃生门）
 * 幂等： observers/监听只挂一次；样式注入用专用 class 标记。
 */
