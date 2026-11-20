/**
 * 软件渲染检测（Win11 GPU 黑名单机识别）：
 * 部分Windows机器GPU被Chromium blocklist回退SwiftShader，Konva canvas全CPU
 * 光栅化导致无限画布卡顿。检测到软渲时 main.js 降级 Konva（pixelRatio=1 +
 * 拖动免 hit graph），画布页弹一次性提示条。
 */

/** 由 WebGL UNMASKED_RENDERER 字符串判定是否软件渲染（纯函数，可单测） */
export function isSoftwareRenderer(rendererStr) {
  return /swiftshader|software|llvmpipe|basic render/i.test(String(rendererStr || ''))
}

/** 探测当前环境：无 WebGL 也视为软渲（连 GPU 上下文都建不起来） */
export function detectSoftwareRendering() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return true
    const d = gl.getExtension('WEBGL_debug_renderer_info')
    const r = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : ''
    return isSoftwareRenderer(r)
  } catch {
    return false
  }
}
