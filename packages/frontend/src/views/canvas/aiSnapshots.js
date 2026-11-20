/**
 * AI 画布操作快照与回滚（对标建议 #6，docs/research-canvas-agent-benchmark.md）。
 *
 * 动机：wb_build_workflow / canvas-ops 批量改画布前，自动打一个**命名持久快照**；
 * 用户对 AI 改动不满意时一键回滚到 AI 动手前。与撤销栈（60 上限、会话内、
 * 混合所有操作）互补——这里是「AI 动作」粒度的持久检查点。
 *
 * 存储：localStorage `artify.canvas.aiSnapshots.v1`，按项目 id 分组，每项目
 * 上限 10 个（FIFO 淘汰）。快照 = { id, label, at, doc }（doc 为 serializeDoc
 * 产物字符串，恢复走既有 applyDoc/parseDoc 管线）。
 *
 * 纯函数 + 显式 storage 注入，可单测；容量满/坏数据静默降级不阻塞画布。
 */

const STORAGE_KEY = 'artify.canvas.aiSnapshots.v1'
const MAX_PER_PROJECT = 10
const MAX_SNAPSHOTS_TOTAL = 40

/** 读取全部快照（坏数据/超容量静默归零） */
export function loadAllSnapshots(storage = localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, projects: {} }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.projects)
      return { version: 1, projects: {} }
    return parsed
  } catch {
    return { version: 1, projects: {} }
  }
}

function persistAll(storage, data) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* 容量满：快照是安全网不是关键路径，静默放弃 */
  }
}

/**
 * 打快照：AI 操作前调用。同项目 FIFO 淘汰最旧；doc 为 serializeDoc 字符串。
 * 返回快照 id（uuid 不可用时退时间戳串）。
 */
export function saveAiSnapshot(storage, projectId, label, doc, now = Date.now()) {
  const data = loadAllSnapshots(storage)
  const list = data.projects[projectId] ?? []
  const id = `snap-${now}-${Math.random().toString(36).slice(2, 8)}`
  const entry = { id, label: String(label ?? '').slice(0, 80) || 'AI 修改前', at: now, doc }
  const next = [...list, entry]
  // FIFO：单项目超限淘汰最旧
  let trimmed = next.slice(-MAX_PER_PROJECT)
  let projects = { ...data.projects, [projectId]: trimmed }
  // 全局超限：按「最旧快照」所属项目整段淘汰（保持每项目完整性）
  const totalOf = (objs) => Object.values(objs).reduce((n, l) => n + (l?.length ?? 0), 0)
  if (totalOf(projects) > MAX_SNAPSHOTS_TOTAL) {
    const sorted = Object.entries(projects).sort((a, b) => (a[1][0]?.at ?? 0) - (b[1][0]?.at ?? 0))
    while (totalOf(projects) > MAX_SNAPSHOTS_TOTAL && sorted.length > 1) {
      const oldest = sorted.shift()
      if (oldest) delete projects[oldest[0]]
    }
    projects = Object.fromEntries(sorted)
  }
  persistAll(storage, { version: 1, projects })
  return id
}

/** 某项目的快照列表（新→旧展示由调用方 reverse；此处按写入序） */
export function listAiSnapshots(storage, projectId) {
  const data = loadAllSnapshots(storage)
  return (data.projects[projectId] ?? []).map(({ doc, ...rest }) => ({
    ...rest,
    bytes: doc.length,
  }))
}

/** 取单个快照 doc（不存在返回 null） */
export function getAiSnapshot(storage, projectId, snapshotId) {
  const list = loadAllSnapshots(storage).projects[projectId] ?? []
  return list.find((s) => s.id === snapshotId)?.doc ?? null
}

/** 删除单个快照 */
export function deleteAiSnapshot(storage, projectId, snapshotId) {
  const data = loadAllSnapshots(storage)
  const list = data.projects[projectId] ?? []
  const next = list.filter((s) => s.id !== snapshotId)
  if (next.length === list.length) return false
  persistAll(storage, { ...data, projects: { ...data.projects, [projectId]: next } })
  return true
}
