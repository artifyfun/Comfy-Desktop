// 模块装配枢纽：显式 import 全部功能模块，保证 esbuild 不整模块 tree-shake。
//
// 为什么必须在这里 import：各模块大量函数由 **运行时字符串/回调** 触达——
// extension API 的 registerSidebarTab 回调（ensureArtifySidebarTab）、
// LiteGraph 节点注册（registerArtifyCardNode）、postMessage handler
// （handleArtifyMessage）、eventBus 监听（bindComfyApiEvents）。这些调用边
// 静态分析看不见；没有本文件的显式引用，esbuild 会把「看似无调用」的模块
// 整体摇掉（2026-09 实测：产物静默缩到 38KB，运行时注册全部消失）。
import { uuidv4, getRandomColor, colorizeLinks, colorizeCanvas } from './uuid_color.js'
import { getComfyUIApp, handleComfyuiContext, loadCssCode } from './canvas_patches.js'
import {
  getElectronConfig,
  apiRequest,
  getConfig,
  loadWorkflow,
  getQueryParam,
} from './api_workflow.js'
import {
  ARTIFY_CARD_TYPE,
  cardImageCache,
  artifyViewUrl,
  getCardApp,
  registerArtifyCardNode,
} from './card_node.js'
import {
  CANVAS_BRIDGE,
  sendCardsToEmbed,
  spawnDisplayCards,
  handleArtifyMessage,
  postToEmbed,
  getEmbedWindow,
  setEmbedWindow,
} from './card_bridge.js'
import {
  getWorkflowName,
  buildCanvasDigest,
  getChangeTracker,
  findNodeById,
  applyOneOp,
  applyCanvasOps,
  saveExpressCheckpoint,
  pushCanvasDigest,
} from './digest.js'
import { bindComfyApiEvents, startCanvasPoll } from './bridge_events.js'
import { installSidebarWidthGovernor } from './governor.js'
import { ensureArtifySidebarTab } from './sidebar_tab.js'

/** 防摇白名单：打包后保留可达引用。键名即产物内可检索符号。 */
const registry = {
  uuidv4,
  getRandomColor,
  colorizeLinks,
  colorizeCanvas,
  getComfyUIApp,
  handleComfyuiContext,
  loadCssCode,
  getElectronConfig,
  apiRequest,
  getConfig,
  loadWorkflow,
  getQueryParam,
  ARTIFY_CARD_TYPE,
  cardImageCache,
  artifyViewUrl,
  getCardApp,
  registerArtifyCardNode,
  CANVAS_BRIDGE,
  sendCardsToEmbed,
  spawnDisplayCards,
  handleArtifyMessage,
  postToEmbed,
  getEmbedWindow,
  setEmbedWindow,
  getWorkflowName,
  buildCanvasDigest,
  getChangeTracker,
  findNodeById,
  applyOneOp,
  applyCanvasOps,
  saveExpressCheckpoint,
  pushCanvasDigest,
  bindComfyApiEvents,
  startCanvasPoll,
  installSidebarWidthGovernor,
  ensureArtifySidebarTab,
}

/**
 * 装配：由 index.js 的 IIFE 调用。registry 只需被构造一次即构成静态可达；
 * 同时挂到 window 便于真机 CDP 探针按符号检查注入完整性。
 */
export function initModules() {
  window.__artifyInjectRegistry = registry
  return registry
}
