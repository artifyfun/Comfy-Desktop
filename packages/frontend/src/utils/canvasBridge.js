/**
 * 产物 → A 画布 轻量桥（SPA 内跨路由传递）
 * 工作台产物卡「钉到画布」→ push(files)；A 画布 mounted → drain() 取走。
 * 只存文件引用（ComfyUI /view 直出所需字段），不存位图数据。
 */
const pending = []

export function pushFiles(files) {
  if (!Array.isArray(files)) return 0
  for (const f of files) {
    if (f && (f.url || f.filename)) pending.push(f)
  }
  return pending.length
}

export function drainFiles() {
  return pending.splice(0, pending.length)
}

export function pendingCount() {
  return pending.length
}
