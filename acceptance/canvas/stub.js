/**
 * Canvas 验收 stub（agent-browser 浏览器 E2E 用）
 *
 * 与 batch stub 不同：canvas 页纯前端 + localStorage 持久化（无服务器队列），
 * 本 stub 的核心职责 = 在 app boot 前 seed 一个多项目 localStorage store，
 * 使 /canvas 打开即有可交互内容（图片节点/便签/连线），另挂 window.__canvasCtl
 * 供验收脚本重置/扩展数据。
 *
 * 数据契约（views/canvas/projectStore.js）：
 *   artify.canvas.projects.v1 = { version, activeId, projects: CanvasProject[] }
 *   CanvasProject = { id, title, createdAt, updatedAt, doc:{ version:2, name,
 *     viewport:{scale,x,y}, objects[], links[], groups[] } }
 *   object: image={id,type:'image',x,y,width,height,src,persist} /
 *           note ={id,type:'note',x,y,width,height,text}
 *   link  : { id, from, to }  （from=上游源，to=下游目标；E2 参考条取 to===选中id 的 from）
 */
;(function () {
  if (window.__canvasStubInstalled) return
  window.__canvasStubInstalled = true

  const KEY = 'artify.canvas.projects.v1'
  const ORIGIN = location.origin

  // ============ Electron 桥 mock ============
  // 页面 boot 依 isElectron = !!window.electronAPI 走 Electron config 路径（initConfig →
  // getElectronConfig → server_origin）；无此 mock 会走 web config 拿不到 server → /about 兜底。
  // canvas 页实际用不到后端（纯前端 + localStorage），server_origin 指回本站即可。
  window.electronAPI = {
    ArtifyLab: {
      getConfig: async () => ({
        server_origin: ORIGIN,
        serverHost: ORIGIN,
        comfyHost: null,
        activeAppId: null,
        lang: 'zh',
        theme: 'dark',
        api_key: '',
        base_url: '',
        model: '',
        provider: '',
      }),
      getAppInfo: async () => ({ name: 'Artify Lab', version: 'verify' }),
      loadComfyUI: async () => ({ url: ORIGIN }),
    },
  }


  // —— 图片 data URL（内联 SVG，Konva imgCache 可加载渲染）——
  function svgDataUrl(hex, label, w, h) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<rect width="100%" height="100%" fill="' + hex + '"/>' +
      '<text x="50%" y="45%" font-size="26" fill="#fff" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">' + label + '</text>' +
      '</svg>'
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }

  const now = Date.now()
  const H = 3600e3
  function mk(id, title, doc, hoursAgo) {
    const t = now - (hoursAgo || 0) * H
    return {
      id: id,
      title: title,
      createdAt: t,
      updatedAt: t,
      doc: Object.assign(
        { version: 2, name: title, viewport: { scale: 1, x: 0, y: 0 }, objects: [], links: [], groups: [] },
        doc || {},
      ),
    }
  }

  const imgA = svgDataUrl('#e25555', 'A', 240, 168)
  const imgB = svgDataUrl('#4a7de0', 'B', 240, 168)

  const store = {
    version: 1,
    activeId: 'p-main',
    projects: [
      mk('p-main', '验收主画布', {
        objects: [
          // 含 @ 提及标记的便签（E3 显示态净化 / D1d 提及；@[显示名]{图片id}）
          { id: 'n-note1', type: 'note', x: 120, y: 70, width: 220, height: 120,
            text: '说明便签：参考 @[图A]{n-imgA} 与 @[图B]{n-imgB} 两张上游图来出图' },
          { id: 'n-imgA', type: 'image', x: 560, y: 40, width: 240, height: 168, src: imgA, name: '图A' },
          { id: 'n-imgB', type: 'image', x: 560, y: 300, width: 240, height: 168, src: imgB, name: '图B' },
          { id: 'n-note2', type: 'note', x: 100, y: 360, width: 190, height: 110,
            text: '普通便签：无上游依赖' },
        ],
        links: [
          { id: 'l-1', from: 'n-imgA', to: 'n-note1' }, // 图A → 说明便签（note1 上游 = 图A/图B）
          { id: 'l-2', from: 'n-imgB', to: 'n-note1' },
          { id: 'l-3', from: 'n-imgA', to: 'n-imgB' }, // 图A → 图B（选中图B 上游 = 图A）
        ],
      }),
      mk('p-note', '便签项目', {
        objects: [{ id: 'n-solo', type: 'note', x: 200, y: 120, width: 200, height: 120, text: '独立便签内容' }],
      }, 5),
      mk('p-empty', '空画布', {}, 26),
    ],
  }

  localStorage.setItem(KEY, JSON.stringify(store))

  window.__canvasCtl = {
    KEY: KEY,
    get projects() {
      try { return JSON.parse(localStorage.getItem(KEY)).projects } catch { return [] }
    },
    /** 重置回验收默认 seed（清掉验收过程中 UI 造成的改动） */
    reset() {
      localStorage.setItem(KEY, JSON.stringify(store))
      location.reload()
    },
    /** 给当前 active 项目补一个便签（快捷扩展用） */
    addNote(text) {
      try {
        const s = JSON.parse(localStorage.getItem(KEY))
        const p = s.projects.find((x) => x.id === s.activeId)
        if (!p) return { ok: false }
        p.doc.objects.push({
          id: 'n' + Date.now().toString(36),
          type: 'note', x: 200, y: 200, width: 180, height: 100, text: text || 'stub 追加便签',
        })
        p.updatedAt = Date.now()
        localStorage.setItem(KEY, JSON.stringify(s))
        return { ok: true }
      } catch (e) { return { ok: false, error: e.message } }
    },
  }

  console.log('[canvas-stub] seeded', store.projects.length, 'projects; active=', store.activeId)
})()
