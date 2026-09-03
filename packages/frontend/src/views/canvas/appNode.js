/**
 * A 画布 App 节点（P1/P2）——纯函数层
 *
 * App 节点 = A 界面应用（app.template = {prompt, paramsNodes, workflow}）的画布实例：
 *   - 收起态/展开态由渲染层管理；这里只管数据形状与派生
 *   - 参数覆写 params：{ [nodeId]: { [widgetName]: value } }，缺省回落 app 默认
 *   - 运行走服务端 /api/canvas/execute（prompt + nodeOverrides），产物落布回画布
 *
 * 全部纯函数可单测；Konva/网络副作用不在此文件。
 */

/** app 节点默认尺寸（世界坐标） */
export const APP_NODE_W = 300
export const APP_NODE_H = 190

/** 表单字段 widget 类型 → 字段描述（与 genPrompt.js 的 paramsNodes 派生同源语义） */
const WIDGET_FIELD_TYPES = new Set([
  'customtext',
  'string',
  'text',
  'toggle',
  'slider',
  'number',
  'combo',
])

/**
 * 从 app.template.paramsNodes 派生参数表单字段描述（过滤 output 类）。
 * 返回 [{ nodeId, key, label, widget, valueType, min?, max?, step?, precision?, nodeType, widgetType }]
 *  - widget: 'text' | 'switch' | 'slider' | 'number' | 'select' | 'image' | 'audio' | 'video'
 *  - nodeType: ComfyUI 节点 class_type（LoadImage 等，图片槽识别用）
 */
export function paramFieldsFromTemplate(app) {
  const nodes = app?.template?.paramsNodes
  if (!Array.isArray(nodes)) return []
  const prompt = app?.template?.prompt || {}
  const fields = []
  for (const node of nodes) {
    if (!node || node.category === 'output') continue
    const w = node.selectedWidget
    if (!w || typeof w.name !== 'string') continue
    // class_type 优先取 prompt 图（paramsNode.type 是 widget 值类型如 string，
    // 不是 ComfyUI 节点类型；历史模板 paramsNodes 无 type 字段时回落 node.type）
    const nodeType = prompt[String(node.id)]?.class_type || node.type
    const widget = widgetKindOf(nodeType, w)
    if (!widget) continue
    fields.push({
      nodeId: String(node.id),
      key: w.name,
      label:
        node.description ||
        (w.name ? `${node.title || node.id} - ${w.name}` : node.title || String(node.id)),
      widget,
      valueType:
        widget === 'switch'
          ? 'boolean'
          : widget === 'slider' || widget === 'number'
            ? 'number'
            : 'string',
      min: w.options?.min,
      max: w.options?.max,
      step: w.options?.step,
      precision: w.options?.precision,
      nodeType,
      widgetType: w.type,
    })
  }
  return fields
}

/** 单个 paramsNode → 表单 widget 种类；无法识别返回 null（字段跳过） */
function widgetKindOf(nodeType, w) {
  // LoadImage/LoadAudio/LoadVideo 的文件槽是上传位：按 ComfyUI 节点类型判定。
  // paramsNode.type 是 widget 值类型（string 等）而非节点类型；历史模板
  // selectedWidget.type 也可能是 string 而非 combo——都不能作文件槽依据
  if (nodeType === 'LoadImage' && w.name === 'image') return 'image'
  if (nodeType === 'LoadAudio' && w.name === 'audio') return 'audio'
  if (nodeType === 'LoadVideo' && w.name === 'video') return 'video'
  if (w.type === 'toggle') return 'switch'
  if (w.type === 'slider') return 'slider'
  if (w.type === 'number') return 'number'
  if (w.type === 'customtext' || w.type === 'string' || w.type === 'text') return 'text'
  if (w.type === 'combo') return 'select'
  return null
}

/**
 * 新建 app 节点对象（objects 数组成员；doc v2 开放字段袋，旧文档解析不受影响）。
 * params 初始化为空对象（= 全部用 app 默认值）。
 */
export function makeAppNode(appId, name, wx, wy, extra = {}) {
  return {
    id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
    type: 'app',
    appId: String(appId || ''),
    name: String(name || ''),
    x: Math.round(wx - APP_NODE_W / 2),
    y: Math.round(wy - APP_NODE_H / 2),
    width: APP_NODE_W,
    height: APP_NODE_H,
    params: {},
    status: 'idle', // idle | running | success | error
    statusText: '',
    lastRun: null, // { promptId, at }
    ...(extra || {}),
  }
}

/**
 * 上游收集：沿 links 反向（指向该节点的连线 from 端）取直接上游物件。
 * 返回 { images: [image物件], notes: [note物件], apps: [app物件], srcIds: [物件id] }
 */
export function collectUpstream(nodeId, objects, links) {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const seen = new Set()
  const images = []
  const notes = []
  const apps = []
  const srcIds = []
  for (const l of links) {
    if (l.to !== nodeId || seen.has(l.from)) continue
    seen.add(l.from)
    const o = byId.get(l.from)
    if (!o) continue
    srcIds.push(o.id)
    if (o.type === 'image') images.push(o)
    else if (o.type === 'note') notes.push(o)
    else if (o.type === 'app') apps.push(o)
  }
  // D1d @ 提及融合：上游 note 文本里 @ 的画布图片（排除已被连线喂过的）
  // 也并入 images —— 便签里“用 @图A 做 XX”即可喂图片槽，无需手动连线
  const linkedIds = new Set(srcIds)
  for (const n of notes) {
    for (const rid of mentionImageIds(n.text || '', objects)) {
      const img = byId.get(rid)
      if (img && img.type === 'image' && !linkedIds.has(rid)) {
        linkedIds.add(rid)
        images.push(img)
      }
    }
  }
  return { images, notes, apps, srcIds }
}

/**
 * D1d：便签文本 @ 提及 → 图片物件 id 列表。
 * 语法：`@[...,]{id}` 尾缀标记（插入时生成）；裸 `@名称` 不带 id 不解析
 * （避免误匹配普通文本），回退按名称唯一匹配图片 name。
 */
export function mentionImageIds(text, objects) {
  if (!text || !text.includes('@')) return []
  const ids = []
  const re = /@\[([^\]]*)\]\{([^}]+)\}/g
  let m
  while ((m = re.exec(text))) {
    const id = m[2]
    if (objects.some((o) => o.id === id && o.type === 'image')) ids.push(id)
  }
  return ids
}

/**
 * image 物件 → ComfyUI 输入文件引用 { filename, subfolder, type }。
 * 与画布 refOf 同构：仅 /view URL 可反解；blob:/data: 返回 null。
 */
export function imageObjectRef(o) {
  if (!o || o.type !== 'image' || !o.src) return null
  try {
    const u = new URL(o.src)
    if (!u.pathname.endsWith('/view')) return null
    return {
      filename: u.searchParams.get('filename') || '',
      subfolder: u.searchParams.get('subfolder') || '',
      type: u.searchParams.get('type') || 'output',
    }
  } catch {
    return null
  }
}

/**
 * 聚合参数优先级合并（高 → 低）：节点卡参数 params > 上游喂养 upstream > app 默认（不写）。
 * fields: paramFieldsFromTemplate 产物；upstream: collectUpstream 产物。
 * 返回 { overrides: { [nodeId]: { [widget]: value } }, fedFields: [fieldLabel...] }
 *  - 图片/音频/视频槽：上游 image 物件按声明顺序填（filename 引用）
 *  - 文本槽：上游 note 文本按顺序填（有用户参数则不覆盖）
 */
export function buildNodeOverrides(node, fields, upstream) {
  const overrides = {}
  const fed = []
  const params = node?.params || {}
  let imgIdx = 0
  let noteIdx = 0
  for (const f of fields) {
    const userVal = params[f.nodeId]?.[f.key]
    if (userVal !== undefined && userVal !== null && userVal !== '') {
      setOverride(overrides, f, userVal)
      continue
    }
    // 上游喂养
    if (f.widget === 'image' || f.widget === 'audio' || f.widget === 'video') {
      const img = upstream?.images?.[imgIdx]
      imgIdx++
      if (img) {
        const ref = imageObjectRef(img)
        if (ref && ref.filename) {
          setOverride(overrides, f, ref.filename)
          fed.push(`${f.label} ← ${img.name || ref.filename}`)
        }
      }
    } else if (f.widget === 'text') {
      const note = upstream?.notes?.[noteIdx]
      if (note && typeof note.text === 'string' && note.text.trim()) {
        noteIdx++
        setOverride(overrides, f, note.text)
        fed.push(`${f.label} ← 便签#${note.id.slice(-4)}`)
      }
    }
  }
  return { overrides, fedFields: fed }
}

function setOverride(overrides, field, value) {
  if (!overrides[field.nodeId]) overrides[field.nodeId] = {}
  overrides[field.nodeId][field.key] = value
}

/**
 * 产物落布坐标：节点右侧一列，间距 16（世界坐标）。
 * files: [{filename, subfolder?, type?}]；返回每文件 { x, y } 光标。
 */
export function artifactLayout(node, count, widths = []) {
  const out = []
  let y = node.y
  for (let i = 0; i < count; i++) {
    const h = widths[i] || 260
    out.push({ x: node.x + node.width + 40, y })
    y += h + 16
  }
  return out
}

/**
 * digest 扩展（P3）：app 节点 → 感知摘要行。
 * 返回 [{ id, name, appId, status, params }]（params 为紧凑字符串摘要）。
 */
export function appNodesDigest(objects) {
  return (objects || [])
    .filter((o) => o.type === 'app')
    .map((o) => ({
      id: o.id,
      name: o.name || o.appId,
      appId: o.appId,
      status: o.status || 'idle',
      params: digestParams(o.params),
    }))
}

function digestParams(params) {
  const parts = []
  for (const [nid, widgets] of Object.entries(params || {})) {
    for (const [k, v] of Object.entries(widgets || {})) {
      const s = typeof v === 'string' ? (v.length > 24 ? v.slice(0, 24) + '…' : v) : String(v)
      parts.push(`${nid}.${k}=${s}`)
    }
  }
  return parts.join(' | ')
}
