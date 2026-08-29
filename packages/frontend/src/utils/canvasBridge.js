/**
 * 产物 → A 画布 轻量桥（SPA 内跨路由传递）
 * 工作台产物卡「钉到画布」→ push(files)；A 画布 mounted → drain() 取走。
 * 只存文件引用（ComfyUI /view 直出所需字段），不存位图数据。
 *
 * 反向通道：A 画布选区 → 工作台附件。
 * 画布「发送到工作台」→ pushAttachments(files)；工作台 mounted → drainAttachments()
 * → 直接入 draftAttachments（/view 引用免上传，同 embed 的 card-attach 形态）。
 */
const pending = []
const attachments = []

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

export function pushAttachments(files) {
  if (!Array.isArray(files)) return 0
  let n = 0
  for (const f of files) {
    if (f && f.filename) {
      attachments.push(f)
      n++
    }
  }
  return n
}

export function drainAttachments() {
  return attachments.splice(0, attachments.length)
}

export function pendingAttachmentCount() {
  return attachments.length
}
