// ============================================================
// comfy_inject 入口——装配 src/inject/ 模块，esbuild 打包为 IIFE 产出
// public/comfy_inject.js（链路: scripts/build-inject.mjs，build 时再经
// terser 压缩为 dist/frontend/comfy_inject.min.js）。electron 主进程的
// 消费方（artifylab/index.ts、extensions.ts）只认产物文件名，无感知。
//
// 幂等保护：本脚本可能被多次注入（comfyView 的 attach 注入、WorkflowModal
// iframe 的子 frame 注入、iframe 重复导航），重复执行会导致双浮动按钮、
// 双 eventBus 监听等副作用，直接跳过。整体包在 IIFE 内：顶层 return 在
// eval/executeJavaScript（以及部分 ComfyUI 宿主页面上下文）中非法，
// 函数内 return 则所有路径都合法。
// ============================================================
import { installBootstrap } from './bootstrap.js'
import { initModules } from './modules.js'
;(function () {
  if (window.__artifyInjectLoaded) {
    return
  }
  window.__artifyInjectLoaded = true

  installBootstrap()
  initModules()
})()
