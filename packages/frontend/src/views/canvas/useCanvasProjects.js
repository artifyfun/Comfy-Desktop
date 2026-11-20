/**
 * 多画布项目集（S1）+ E4 项目卡（composable）——canvas/index.vue 拆分（第一批①c）。
 *
 * 项目集 CRUD（建/切/重命名/单删/批量删）、项目卡统计/相对时间/内联重命名、
 * 单项目导出。store 持久化走 projectStore 模块（I/O 适配层）；与画布交互
 * 仅两个钩子：syncActiveDocToStore（当前 doc 入库）/loadProjectIntoCanvas
 * （删除后重载），经 deps 注入。
 */
import { ref, reactive, computed, nextTick } from 'vue'
import { message, Modal } from 'ant-design-vue'

/**
 * @param deps { projectStore, t, syncActiveDocToStore, loadProjectIntoCanvas,
 *               buildSelectionZipHelpers? } —— 页面持有的共享状态与钩子
 */
export function useCanvasProjects(deps) {
  const { projectStore, t, syncActiveDocToStore, loadProjectIntoCanvas } = deps
  const {
    psUpdateProjectDoc,
    psSwitchProject,
    psAddProject,
    psRenameProject,
    psDeleteProject,
    psCloneProject,
    bootProjectStore,
    persistProjectStore,
    normalizeStore,
    projectCardStats,
    buildExportPayload,
    packExportZip,
    makeViewport,
  } = deps.engine

  const activeProject = computed(
    () => projectStore.projects.find((p) => p.id === projectStore.activeId) || null,
  )
  const projectMenuOpen = ref(false)

  /** 当前 doc → 项目集（saveNow 一并落盘） */
  function syncDoc() {
    if (!projectStore.activeId) return
    Object.assign(
      projectStore,
      psUpdateProjectDoc(normalizeStore({ ...projectStore }), projectStore.activeId, {
        version: 2,
        name: activeProject.value?.title || t('canvasUntitled'),
        viewport: {
          scale: deps.viewport.value.scale,
          x: deps.viewport.value.x,
          y: deps.viewport.value.y,
        },
        objects: deps.objects.value.map((o) => ({ ...o })),
        links: deps.links.value.map((l) => ({ ...l })),
        groups: deps.groups.value.map((g) => ({ ...g })),
      }),
    )
  }

  /** 切换项目：当前内容先入库，再载入目标 */
  function openProjectById(id) {
    if (id === projectStore.activeId) {
      projectMenuOpen.value = false
      return
    }
    syncDoc()
    persistProjects()
    const target = projectStore.projects.find((p) => p.id === id)
    if (!target) return
    deps.beforeChange()
    deps.objects.value = target.doc.objects.map((o) => ({ ...o }))
    deps.links.value = target.doc.links.map((l) => ({ ...l }))
    deps.groups.value = target.doc.groups.map((g) => ({ ...g }))
    deps.viewport.value = makeViewport(
      target.doc.viewport.scale,
      target.doc.viewport.x,
      target.doc.viewport.y,
    )
    Object.assign(projectStore, psSwitchProject({ ...projectStore }, id))
    deps.selection.value = []
    deps.selectedLinkId.value = null
    deps.appPanel.id = null
    deps.resetHistory()
    deps.afterProjectSwitch()
    persistProjects()
    projectMenuOpen.value = false
    message.info(t('canvasProjectSwitched').replace('{n}', target.title))
  }

  function createNewProject() {
    syncDoc()
    const n = projectStore.projects.length + 1
    Object.assign(
      projectStore,
      psAddProject({ ...projectStore }, t('canvasProjectDefaultName').replace('{n}', String(n))),
    )
    loadProjectIntoCanvas()
    persistProjects()
    projectMenuOpen.value = false
  }

  function renameActiveProject(title) {
    if (!projectStore.activeId) return
    Object.assign(projectStore, psRenameProject({ ...projectStore }, projectStore.activeId, title))
    persistProjects()
  }

  function persistProjects() {
    persistProjectStore(projectStore)
  }

  // —— E4 项目卡：统计/相对时间/内联重命名/单删/导出/批量删除 ——
  const prjBatchMode = ref(false)
  const prjChecked = reactive(new Set())
  const prjRenameId = ref(null)
  const prjRenameInput = ref(null)

  function prjStats(pr) {
    return projectCardStats(pr)
  }
  function prjRelTime(pr) {
    const st = prjStats(pr)
    const key =
      st.rel === 'justNow'
        ? 'canvasPrjJustNow'
        : st.rel === 'minutesAgo'
          ? 'canvasPrjMinutesAgo'
          : st.rel === 'hoursAgo'
            ? 'canvasPrjHoursAgo'
            : 'canvasPrjDaysAgo'
    return t(key).replace('{n}', String(st.relValue))
  }
  function togglePrjCheck(id) {
    if (prjChecked.has(id)) prjChecked.delete(id)
    else prjChecked.add(id)
  }
  function startPrjRename(id) {
    prjRenameId.value = id
    nextTick(() => {
      const el = Array.isArray(prjRenameInput.value)
        ? prjRenameInput.value[0]
        : prjRenameInput.value
      el?.focus?.()
      el?.select?.()
    })
  }
  function commitPrjRename(e) {
    const title = String(e.target.value || '').trim()
    const id = prjRenameId.value
    prjRenameId.value = null
    if (!id || !title) return
    Object.assign(projectStore, psRenameProject({ ...projectStore }, id, title))
    persistProjects()
  }

  /** E4：单项目导出（复用当前导出管线） */
  function exportProjectById(id) {
    syncDoc()
    const clone = psCloneProject({ ...projectStore }, id)
    if (!clone) return
    const { payload, files } = buildExportPayload([clone])
    packExportZip(payload, files).then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const pr = projectStore.projects.find((p) => p.id === id)
      a.download = `${(pr?.title || 'canvas').replace(/[\\/:*?"<>|]/g, '_')}.artify-canvas.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      message.success(t('canvasExported'))
    })
  }

  /** E4：卡片单删（含当前项目时切走并重载） */
  function deleteProjectById(id) {
    const pr = projectStore.projects.find((p) => p.id === id)
    if (!pr) return
    Modal.confirm({
      title: t('canvasProjectDeleteTitle'),
      content: t('canvasProjectDeleteConfirm').replace('{n}', pr.title),
      okText: t('canvasProjectDeleteOk'),
      cancelText: t('cancel'),
      okButtonProps: { danger: true },
      onOk: () => {
        // fix: 删唯一项目时 psDeleteProject 兜底新建"未命名画布"（新 id），
        // 旧条件比较的是 computed 重算后的 activeProject（已指向新项目）→ 永假
        // → 画布残留旧节点，且后续 syncActiveDocToStore 把旧内容写进新项目。
        // 改为记录删除前的项目 id：变了就无条件重装载。
        const beforeId = projectStore.activeId
        Object.assign(projectStore, psDeleteProject({ ...projectStore }, id))
        if (projectStore.activeId !== beforeId) loadProjectIntoCanvas()
        persistProjects()
      },
    })
  }

  /** E4：批量删除（勾选集；当前项目被删则切默认并重载） */
  function exitPrjBatch() {
    prjBatchMode.value = false
    prjChecked.clear()
  }
  function deleteCheckedProjects() {
    const ids = Array.from(prjChecked)
    if (!ids.length) return
    Modal.confirm({
      title: t('canvasPrjBatchDel'),
      content: `${ids.length} → ${ids
        .slice(0, 5)
        .map((i) => projectStore.projects.find((p) => p.id === i)?.title || i)
        .join('、')}${ids.length > 5 ? '…' : ''}`,
      okText: t('canvasProjectDeleteOk'),
      cancelText: t('cancel'),
      okButtonProps: { danger: true },
      onOk: () => {
        // fix: 同单卡删除——先记删除前 activeId，避免 computed 已重算导致漏装载
        const beforeId = projectStore.activeId
        let store = { ...projectStore }
        for (const id of ids) store = psDeleteProject(store, id)
        Object.assign(projectStore, store)
        if (!projectStore.projects.some((p) => p.id === beforeId)) loadProjectIntoCanvas()
        persistProjects()
        prjChecked.clear()
        prjBatchMode.value = false
      },
    })
  }

  function deleteActiveProject() {
    const cur = activeProject.value
    if (!cur) return
    Modal.confirm({
      title: t('canvasProjectDeleteTitle'),
      content: t('canvasProjectDeleteConfirm').replace('{n}', cur.title),
      okText: t('canvasProjectDeleteOk'),
      cancelText: t('cancel'),
      okButtonProps: { danger: true },
      onOk: () => {
        Object.assign(projectStore, psDeleteProject({ ...projectStore }, cur.id))
        loadProjectIntoCanvas()
        persistProjects()
      },
    })
  }

  /** 当前项目导出（项目菜单入口；与 exportProjectById 同管线） */
  function exportCurrentProject() {
    syncDoc()
    const clone = psCloneProject({ ...projectStore }, projectStore.activeId)
    if (!clone) return
    const { payload, files } = buildExportPayload([clone])
    packExportZip(payload, files).then((blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(activeProject.value?.title || 'canvas').replace(/[\\/:*?"<>|]/g, '_')}.artify-canvas.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      message.success(t('canvasExported'))
    })
  }

  return {
    exportCurrentProject,
    activeProject,
    projectMenuOpen,
    syncDoc,
    openProjectById,
    createNewProject,
    renameActiveProject,
    persistProjects,
    prjBatchMode,
    prjChecked,
    prjRenameId,
    prjRenameInput,
    prjStats,
    prjRelTime,
    togglePrjCheck,
    startPrjRename,
    commitPrjRename,
    exportProjectById,
    deleteProjectById,
    exitPrjBatch,
    deleteCheckedProjects,
    deleteActiveProject,
  }
}
