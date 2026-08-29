/**
 * 画布工作台模式总线（画布页内嵌工作台时由画布页设置）
 *
 * 宿主协议（画布页 ↔ 内嵌工作台）：
 *   onResult(cb) / off        工作台产物 → 画布自动落布
 *   onAttachments(cb) / off   画布选区 → 工作台参考图
 *
 * 实现说明：状态挂在 window.__artifyCanvasModeBus 上。
 * 不能用模块级变量——vite dev 下同一模块可能因 URL 差异（alias/查询串）
 * 出现多实例，动态 import 拿到的和组件 import 的不是同一份；window 是
 * 同源单页的真单例，跨组件/跨动态 import 都一致。
 */
const BUS_KEY = '__artifyCanvasModeBus'

function bus() {
  if (!window[BUS_KEY]) {
    window[BUS_KEY] = {
      resultListeners: new Set(),
      attachmentListeners: new Set(),
    }
  }
  return window[BUS_KEY]
}

export function useCanvasMode() {
  const b = bus()
  return {
    /** 工作台侧：产物 → 画布。返回 off 函数 */
    onResult(cb) {
      b.resultListeners.add(cb)
      return () => b.resultListeners.delete(cb)
    },
    emitResult(files) {
      b.resultListeners.forEach((cb) => cb(files))
    },
    /** 画布侧：选区 → 工作台。返回 off 函数 */
    onAttachments(cb) {
      b.attachmentListeners.add(cb)
      return () => b.attachmentListeners.delete(cb)
    },
    emitAttachments(files) {
      b.attachmentListeners.forEach((cb) => cb(files))
    },
    clear() {
      b.resultListeners.clear()
      b.attachmentListeners.clear()
    },
  }
}
