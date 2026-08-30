import { getEmbedWindow } from './card_bridge.js'
import { sendCardsToEmbed } from './card_bridge.js'
// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export const ARTIFY_CARD_TYPE = 'ArtifyDisplayCard'
/** 与工作台 A UI 的 iframe 通信（内容窗口引用在 sidebar tab 注册时捕获） */
/** 已加载的 Image 对象缓存（filename 键），避免重复解码 */
export const cardImageCache = new Map()

/** /view URL：与后端 WorkbenchOutputFile{filename,subfolder,type} 约定一致。
 * ComfyUI 与本脚本同源（注入页即画布页），直接用相对路径拼 /view。
 * workbench 后端（server_origin）与 ComfyUI 是两个进程——产出文件在
 * ComfyUI 的 output 目录，由 ComfyUI 自己的 /view 直出，不走 A UI。 */
export function artifyViewUrl(f) {
  const p = new URLSearchParams({ filename: f.filename, type: f.type || 'output' })
  if (f.subfolder) p.set('subfolder', f.subfolder)
  return '/view?' + p.toString()
}

export function getCardApp() {
  const app = window.app
  if (!app || !app.graph) return null
  return app
}

/**
 * 注册陈列卡片节点类型（幂等；等 LiteGraph 就绪后由 ensureArtifyCard 注册）。
 * 绘制逻辑对齐官方 IMAGE_PREVIEW widget：drawImage 平铺 + low_quality 简化。
 */
export function registerArtifyCardNode(LiteGraph) {
  if (!LiteGraph || LiteGraph.registered_node_types[ARTIFY_CARD_TYPE]) return
  // 新版 litegraph（fork 内嵌 ComfyUI_frontend）在 createNode 里调
  // node.computeSize() 等基类方法——节点类必须继承 LGraphNode，
  // 裸 function 构造器会直接 TypeError。
  const LGBase = window.LGraphNode || LiteGraph.LGraphNode
  if (!LGBase) {
    console.warn('[ArtifyInject] LGraphNode not found, skip card node registration')
    return
  }
  class ArtifyDisplayCard extends LGBase {
    constructor(title) {
      super(title)
      this.serialize_widgets = false
    }
  }
  ArtifyDisplayCard.title = 'Artify 卡片'
  ArtifyDisplayCard.desc = 'AI 工作台产物陈列（不参与执行）'
  ArtifyDisplayCard.title_color = '#7c5cff'
  ArtifyDisplayCard.prototype.onConfigure = function () {
    // 从 workflow JSON 恢复后重建 imgs（序列化只存引用不存 Image 对象）
    this.size = this.size || [256, 320]
  }

  LiteGraph.registerNodeType(ARTIFY_CARD_TYPE, ArtifyDisplayCard)
  const Proto = ArtifyDisplayCard.prototype
  Proto.isVirtualNode = true

  Proto.onAdded = function () {
    this.mode = 2 // LGraphEventMode.NEVER
    this.setDirtyCanvas(true, true)
  }

  /** files: [{filename,subfolder,type}]；逐张加载解码后进 imgs */
  Proto.setFiles = function (files) {
    this.properties = this.properties || {}
    this.properties.files = files
    this.imgs = []
    this.size = this.size || [256, 320]
    const app = getCardApp()
    for (const f of files) {
      const img = new Image()
      img.onload = () => {
        if (!this.imgs) this.imgs = []
        this.imgs.push(img)
        this.setDirtyCanvas(true, true)
        this.onResize && this.onResize(this.size)
      }
      img.onerror = () => {
        console.warn('[ArtifyInject] card image failed:', f.filename)
      }
      img.src = artifyViewUrl(f)
    }
    this.setDirtyCanvas(true, true)
  }

  // 首帧比例适配：第一张图到位后按图像宽高比调一次高度（宽度固定）
  Proto.onResize = function () {
    if (this.imgs && this.imgs[0] && this.imgs[0].naturalWidth) {
      const img = this.imgs[0]
      const ratio = img.naturalHeight / img.naturalWidth
      const h = Math.max(160, Math.min(560, 256 * ratio + 64))
      if (Math.abs(this.size[1] - h) > 8) {
        this.size[1] = h
        this.setDirtyCanvas(true, true)
      }
    }
  }

  Proto.onDrawBackground = function (ctx) {
    // 图片区域裁剪：标题栏以下（litegraph 在 onDrawBackground 时已平移到内容区）
    if (!this.imgs || !this.imgs.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(0, 0, this.size[0], this.size[1])
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '12px sans-serif'
      ctx.fillText('…', 8, 18)
      return
    }
    const cols = this.imgs.length > 1 ? 2 : 1
    const rows = Math.ceil(this.imgs.length / cols)
    const gap = 4
    const cw = (this.size[0] - gap * (cols + 1)) / cols
    const ch = (this.size[1] - gap * (rows + 1)) / rows
    for (let i = 0; i < this.imgs.length && i < 8; i++) {
      const img = this.imgs[i]
      const x = gap + (i % cols) * (cw + gap)
      const y = gap + Math.floor(i / cols) * (ch + gap)
      // cover 裁剪绘制（等比放大取中）
      const iw = img.naturalWidth || img.width
      const ih = img.naturalHeight || img.height
      if (!iw || !ih) continue
      const s = Math.max(cw / iw, ch / ih)
      const sw = cw / s
      const sh = ch / s
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, cw, ch)
    }
  }

  /** 双击 → 回填给工作台侧边栏 */
  Proto.onDblClick = function () {
    sendCardsToEmbed([this])
  }

  /** 右键菜单：回填 / 从画布移除（走官方 getNodeMenuOptions 注入） */
  const origGetNodeMenuOptions =
    window.LiteGraph && window.LiteGraph.LGraphCanvas
      ? window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions
      : null
  if (origGetNodeMenuOptions) {
    window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
      const options = origGetNodeMenuOptions.call(this, node)
      if (node && node.type === ARTIFY_CARD_TYPE) {
        const cardOptions = [
          {
            content: '回填到工作台',
            callback: () => sendCardsToEmbed([node]),
          },
          {
            content: '从画布移除',
            callback: () => {
              const graph = node.graph || (getCardApp() && getCardApp().graph)
              if (graph) graph.remove(node)
            },
          },
          null, // 分隔线
        ]
        // 官方菜单结构：[null, ...options, null]；把卡片项插在最前
        if (options && options.length) {
          options.splice(options.length - 1, 0, ...cardOptions)
        } else {
          return [null, ...cardOptions, null]
        }
      }
      return options
    }
  }
}

/** 把选中卡片的文件引用发给工作台 embed iframe（回填） */
