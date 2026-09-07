/**
 * canvasActions —— 画布右键菜单动作注册表（#5）。
 *
 * 此前 ctxItems 是 ~250 行 computed：20+ 个动作的 icon/label/谓词/闭包
 * 全部内联，无法脱离组件单测。现在动作声明为数据（可见谓词 actionGroup
 * 纯函数可测），index.vue 只注入 run 实现。
 *
 * 谓词语义（与原 computed 逐条对应）：
 *   - always：无条件出现（copy / z 序 / 删除）
 *   - singleNote / singleFrame：恰好一个该类型选中
 *   - anyImageMeta：任一选中图片带 meta.prompt
 *   - anyApp / anyImage：任一选中为该类型
 *   - multi（≥2）/ triple（≥3）：选中数门槛（对齐/组合、分布）
 *   - multiImage（≥2 张图片）：网格排列
 */
export const CANVAS_CTX_ACTIONS = [
  { key: 'copy', icon: 'fa-copy', labelKey: 'canvasMenuCopy', when: 'always' },
  { key: 'note-edit', icon: 'fa-pen', labelKey: 'canvasMenuEditNote', when: 'singleNote' },
  { key: 'frame-rename', icon: 'fa-pen', labelKey: 'canvasRenameFrame', when: 'singleFrame' },
  { key: 'gen-info', icon: 'fa-circle-info', labelKey: 'canvasGenInfoTitle', when: 'anyImageMeta' },
  { key: 'app-run', icon: 'fa-play', labelKey: 'canvasCtxRunApp', when: 'anyApp' },
  { key: 'app-panel', icon: 'fa-gear', labelKey: 'canvasCtxAppPanel', when: 'anyApp' },
  {
    key: 'app-full',
    icon: 'fa-up-right-from-square',
    labelKey: 'canvasCtxAppFull',
    when: 'anyApp',
  },
  { key: 'ref', icon: 'fa-paper-plane', labelKey: 'canvasMenuSendWb', when: 'anyImage' },
  { key: 'gen', icon: 'fa-wand-magic-sparkles', labelKey: 'canvasMenuGen', when: 'anyImage' },
  { key: 'crop', icon: 'fa-crop', labelKey: 'canvasCropTool', when: 'anyImage' },
  { key: 'inpaint', icon: 'fa-paint-brush', labelKey: 'canvasMenuInpaint', when: 'anyImage' },
  { key: 'sep-ai', sep: true, when: 'anyImage' },
  // AI 组（子菜单，父项 anyImage 可见）
  {
    key: 'ai-group',
    icon: 'fa-wand-magic-sparkles',
    labelKey: 'canvasMenuAiGroup',
    when: 'anyImage',
    children: [
      { key: 'reverse', icon: 'fa-comment-dots', labelKey: 'canvasMenuReverse', when: 'anyImage' },
      {
        key: 'enhance',
        icon: 'fa-up-right-and-down-left-from-center',
        labelKey: 'canvasMenuEnhance',
        when: 'anyImage',
      },
      {
        key: 'outpaint',
        icon: 'fa-expand-arrows-alt',
        labelKey: 'canvasMenuOutpaint',
        when: 'anyImage',
      },
      { key: 'video', icon: 'fa-film', labelKey: 'canvasMenuVideo', when: 'anyImage' },
      { key: 'char', icon: 'fa-user-tag', labelKey: 'canvasMenuSetChar', when: 'anyImage' },
      { key: 'style', icon: 'fa-palette', labelKey: 'canvasMenuSetStyle', when: 'anyImage' },
    ],
  },
  { key: 'compose', icon: 'fa-layer-group', labelKey: 'canvasMenuCompose', when: 'multi' },
  { key: 'group', icon: 'fa-object-group', labelKey: 'canvasGroupSel', when: 'multi' },
  { key: 'exportSel', icon: 'fa-file-zipper', labelKey: 'canvasExportSelBtn', when: 'anyImage' },
  { key: 'gridImg', icon: 'fa-table-cells', labelKey: 'canvasGridBtn', when: 'multiImage' },
  { key: 'alignL', icon: 'fa-align-left', labelKey: 'canvasAlignLeft', when: 'multi' },
  { key: 'alignH', icon: 'fa-align-center', labelKey: 'canvasAlignHCenter', when: 'multi' },
  { key: 'alignR', icon: 'fa-align-right', labelKey: 'canvasAlignRight', when: 'multi' },
  { key: 'alignT', icon: 'fa-arrow-up-long', labelKey: 'canvasAlignTop', when: 'multi' },
  { key: 'alignV', icon: 'fa-arrows-up-down', labelKey: 'canvasAlignVCenter', when: 'multi' },
  { key: 'alignB', icon: 'fa-arrow-down-long', labelKey: 'canvasAlignBottom', when: 'multi' },
  { key: 'distH', icon: 'fa-arrows-left-right-to-line', labelKey: 'canvasDistH', when: 'triple' },
  {
    key: 'distV',
    icon: 'fa-arrows-up-down-up-down-line',
    labelKey: 'canvasDistV',
    when: 'triple',
  },
  { key: 'front', icon: 'fa-layer-group', labelKey: 'canvasMenuFront', when: 'always' },
  { key: 'forward', icon: 'fa-arrow-up', labelKey: 'canvasMenuForward', when: 'always' },
  { key: 'backward', icon: 'fa-arrow-down', labelKey: 'canvasMenuBackward', when: 'always' },
  { key: 'back', icon: 'fa-layer-group', labelKey: 'canvasMenuBack', when: 'always' },
  { key: 'del', icon: 'fa-trash', labelKey: 'canvasMenuDelete', when: 'always' },
]

/**
 * 选中集 → 谓词环境（纯函数，可单测）。
 * @param objects 画布全量物件
 * @param ids 选中 id 列表
 */
export function ctxPredicateEnv(objects, ids) {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const picked = ids.map((id) => byId.get(id)).filter(Boolean)
  const of = (type) => picked.filter((o) => o.type === type)
  return {
    always: true,
    singleNote: of('note').length === 1,
    singleFrame: of('frame').length === 1,
    anyImageMeta: picked.some((o) => o.meta?.prompt),
    anyApp: of('app').length > 0,
    anyImage: of('image').length > 0,
    multi: ids.length >= 2,
    triple: ids.length >= 3,
    multiImage: of('image').length >= 2,
  }
}

/** 注册表按谓词过滤 → 菜单项形状（run 由 UI 层注入；children 同样过滤） */
export function buildCtxItems(objects, ids, actions, run, sepBetween = false) {
  const env = ctxPredicateEnv(objects, ids)
  const out = []
  let lastWasSep = true // 开头不放分隔线
  for (const a of actions ?? CANVAS_CTX_ACTIONS) {
    if (a.when && !env[a.when]) continue
    if (a.sep) {
      if (lastWasSep) continue
      out.push({ key: a.key, sep: true })
      lastWasSep = true
      continue
    }
    const item = { key: a.key, icon: a.icon, label: undefined, run: run(a.key, ids) }
    if (a.labelKey) item.labelKey = a.labelKey
    if (a.children) {
      item.children = a.children
        .filter((c) => !c.when || env[c.when])
        .map((c) => ({ key: c.key, icon: c.icon, labelKey: c.labelKey, run: run(c.key, ids) }))
    }
    out.push(item)
    lastWasSep = false
  }
  while (out.length && out[out.length - 1].sep) out.pop()
  return out
}
