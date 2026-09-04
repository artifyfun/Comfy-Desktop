import './assets/main.css'
import './assets/antd-custom.css'
import './assets/global.less'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import VueKonva from 'vue-konva'
import Konva from 'konva'
import { detectSoftwareRendering } from './views/canvas/softRender'

import { applyThemeColors } from '@/utils/theme-utils'

import App from './App.vue'
import router from './router'

// —— Win11（等软件渲染机器）无限画布卡顿缓解 ——
// 部分Windows机器GPU被Chromium blocklist回退SwiftShader软件渲染，
// Konva canvas全CPU光栅化，拖动/缩放明显卡顿。检测到软渲时降级：
//   1) pixelRatio=1：不按devicePixelRatio放大光栅面积（1.5x缩放=2.25x像素）
//   2) hitOnDragEnabled=false：拖动中跳过hit graph重绘（up后自动重建）
// GPU正常（Metal/D3D）的机器不受影响，Retina清晰度保持。
const isSoftwareRendering = detectSoftwareRendering()
if (isSoftwareRendering) {
  Konva.hitOnDragEnabled = false
  Konva.pixelRatio = 1
}
// 供画布页提示条复用
window.__SOFT_RENDER__ = isSoftwareRendering

const app = createApp(App)

// 应用主题色
applyThemeColors()

app.use(createPinia())
app.use(router)
// A 界面无限画布（/canvas）的 Konva 渲染层
app.use(VueKonva)

app.mount('#app')
