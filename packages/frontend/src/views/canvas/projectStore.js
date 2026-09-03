/**
 * 多画布项目存储（S1）——纯函数层
 *
 * 存储布局（localStorage）：
 *   artify.canvas.projects.v1 : { version, activeId, projects: CanvasProject[] }
 *   artify.canvas.doc.v1      : 旧单画布档（迁移源；迁移成功后保留不动，可回滚）
 *
 * CanvasProject = { id, title, createdAt, updatedAt, doc }，doc 为 parseDoc 产物
 * （objects/links/groups/viewport/name 全量内嵌，项目自包含可整体导入导出）。
 *
 * 全部纯函数可单测；localStorage 读写由 UI 层做（这里只管数据形状与派生）。
 */

const PROJECTS_KEY = 'artify.canvas.projects.v1'
const LEGACY_DOC_KEY = 'artify.canvas.doc.v1'

/** 新建项目工厂（空画布） */
export function makeProject(title, id, now = Date.now()) {
  return {
    id: String(id || 'p' + now + Math.random().toString(36).slice(2, 6)),
    title: String(title || '').trim() || '未命名画布',
    createdAt: now,
    updatedAt: now,
    doc: {
      version: 2,
      name: String(title || '').trim() || '未命名画布',
      viewport: { scale: 1, x: 0, y: 0 },
      objects: [],
      links: [],
      groups: [],
    },
  }
}

/** 空项目集 */
export function emptyStore() {
  return { version: 1, activeId: null, projects: [] }
}

/**
 * 旧单画布档 → 项目集迁移（幂等）：
 * - 无旧档且无项目集 → 首个项目（空画布）
 * - 有旧档且无项目集 → 旧档内容升格为首个项目「未命名画布」
 * - 已有项目集 → 原样返回（不重复迁移）
 * 返回 { store, migrated }，migrated=true 时 UI 层需立即落盘。
 */
export function migrateLegacyStore(rawProjects, rawLegacyDoc) {
  if (rawProjects) {
    const parsed = safeParse(rawProjects)
    if (parsed && Array.isArray(parsed.projects)) {
      return { store: normalizeStore(parsed), migrated: false }
    }
  }
  if (rawLegacyDoc) {
    const legacy = safeParse(rawLegacyDoc)
    if (legacy && Array.isArray(legacy.objects) && legacy.objects.length > 0) {
      const p = makeProject('未命名画布', 'p-legacy', Date.now())
      p.doc = {
        version: legacy.version ?? 1,
        name: legacy.name ?? '未命名画布',
        viewport: {
          scale: legacy.viewport?.scale ?? 1,
          x: legacy.viewport?.x ?? 0,
          y: legacy.viewport?.y ?? 0,
        },
        objects: legacy.objects.filter((o) => o && typeof o.x === 'number'),
        links: Array.isArray(legacy.links) ? legacy.links : [],
        groups: Array.isArray(legacy.groups) ? legacy.groups : [],
      }
      p.title = p.doc.name
      return { store: { version: 1, activeId: p.id, projects: [p] }, migrated: true }
    }
  }
  const first = makeProject('未命名画布', 'p-first', Date.now())
  return { store: { version: 1, activeId: first.id, projects: [first] }, migrated: true }
}

/** 项目集形状防御：过滤残缺项目、修正 activeId */
export function normalizeStore(store) {
  const projects = (store?.projects || [])
    .filter((p) => p && typeof p.id === 'string' && p.doc && Array.isArray(p.doc.objects))
    .map((p) => ({
      id: p.id,
      title: typeof p.title === 'string' && p.title.trim() ? p.title : '未命名画布',
      createdAt: p.createdAt || Date.now(),
      updatedAt: p.updatedAt || Date.now(),
      doc: {
        version: p.doc.version ?? 2,
        name: p.doc.name || p.title || '未命名画布',
        viewport: {
          scale: p.doc.viewport?.scale ?? 1,
          x: p.doc.viewport?.x ?? 0,
          y: p.doc.viewport?.y ?? 0,
        },
        objects: p.doc.objects.filter((o) => o && typeof o.x === 'number'),
        links: Array.isArray(p.doc.links) ? p.doc.links : [],
        groups: Array.isArray(p.doc.groups) ? p.doc.groups : [],
      },
    }))
  const activeId = projects.some((p) => p.id === store?.activeId)
    ? store.activeId
    : (projects[0]?.id ?? null)
  return { version: 1, activeId, projects }
}

/** 新建项目（置顶插入，激活） */
export function addProject(store, title, now = Date.now()) {
  const p = makeProject(title, undefined, now)
  return { version: 1, activeId: p.id, projects: [p, ...store.projects] }
}

/** 重命名（同步 doc.name；空标题回退原标题） */
export function renameProject(store, id, title, now = Date.now()) {
  const t = String(title || '').trim()
  return {
    ...store,
    projects: store.projects.map((p) =>
      p.id === id && t ? { ...p, title: t, updatedAt: now, doc: { ...p.doc, name: t } } : p,
    ),
  }
}

/** 删除项目（删唯一项目时自动补一个空项目；activeId 被删则落到首个） */
export function deleteProject(store, id, now = Date.now()) {
  let projects = store.projects.filter((p) => p.id !== id)
  if (!projects.length) projects = [makeProject('未命名画布', undefined, now)]
  const activeId = projects.some((p) => p.id === store.activeId) ? store.activeId : projects[0].id
  return { version: 1, activeId, projects }
}

/** 切换激活项目 */
export function switchProject(store, id) {
  return store.projects.some((p) => p.id === id) ? { ...store, activeId: id } : store
}

/** 更新当前项目 doc（updatedAt 戳）；id 不存在原样返回 */
export function updateProjectDoc(store, id, doc, now = Date.now()) {
  return {
    ...store,
    projects: store.projects.map((p) => (p.id === id ? { ...p, doc, updatedAt: now } : p)),
  }
}

/** 导出用：单个项目深拷贝 */
export function cloneProject(store, id) {
  const p = store.projects.find((x) => x.id === id)
  return p ? JSON.parse(JSON.stringify(p)) : null
}

/** 导入用：外来项目并集去重（按 id 碰撞则换新 id），置顶并激活 */
export function importProject(store, project, now = Date.now()) {
  if (!project || !project.doc || !Array.isArray(project.doc.objects)) return { store, id: null }
  let p = JSON.parse(JSON.stringify(project))
  if (store.projects.some((x) => x.id === p.id)) {
    p.id = 'p' + now + Math.random().toString(36).slice(2, 6)
  }
  p.title = (p.title || '导入画布').slice(0, 60)
  p.createdAt = p.createdAt || now
  p.updatedAt = now
  return { store: { version: 1, activeId: p.id, projects: [p, ...store.projects] }, id: p.id }
}

export const PROJECTS_STORAGE_KEY = PROJECTS_KEY

/**
 * E4 项目卡统计（纯投影）：物件/连线/便签/图片计数 + 相对时间描述。
 * doc 异常（缺字段/非数组）一律回退 0，卡片永不抛错。
 */
export function projectCardStats(project, now = Date.now()) {
  const objs = Array.isArray(project?.doc?.objects) ? project.doc.objects : []
  const links = Array.isArray(project?.doc?.links) ? project.doc.links : []
  const updatedAt = Number(project?.updatedAt) || now
  const diffMin = Math.max(0, Math.round((now - updatedAt) / 60000))
  const rel =
    diffMin < 1 ? 'justNow' : diffMin < 60 ? 'minutesAgo' : diffMin < 1440 ? 'hoursAgo' : 'daysAgo'
  return {
    objects: objs.length,
    links: links.length,
    images: objs.filter((o) => o?.type === 'image').length,
    notes: objs.filter((o) => o?.type === 'note').length,
    rel,
    relValue:
      diffMin < 60
        ? diffMin
        : diffMin < 1440
          ? Math.round(diffMin / 60)
          : Math.round(diffMin / 1440),
    updatedAt,
  }
}
export const LEGACY_STORAGE_KEY = LEGACY_DOC_KEY

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
