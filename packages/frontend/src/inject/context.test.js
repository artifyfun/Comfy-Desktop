// @vitest-environment happy-dom
/**
 * inject 共享环境状态（context.js）的跨模块读写语义 —— 2026-09-19
 *
 * 背景：`src/inject/` 拆单体时有两处**漏 import**（`api_workflow.js`、`canvas_patches.js`）
 * 无条件使用了 context 的导出（artify_inject / isIframe / artify_playground /
 * isElectron / isArtifyLoading），既没 import 也不是全局 —— esbuild 打包时这些名字
 * 被 mangle 成短名，裸引用退化成未声明全局，**运行时抛 ReferenceError**：
 *   - `loadWorkflow()` 一进来就抛 → standalone 自动加载 activeApp 工作流从未生效
 *   - `doHandleComfyuiContext()` / `colorizeCanvas()` 同理，静默失效
 * 由 W18（真 inject 产物端到端）抓出；`api_workflow.isArtifyLoading` 因为要**赋值**，
 * 不能直接 import（ESM import 绑定只读），故 context 补了 get/set 访问器。
 *
 * 这里只钉访问器语义（静态"有没有漏 import"由 `npx eslint src/inject` 的 no-undef 守）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  artify_inject,
  artify_playground,
  isIframe,
  isElectron,
  getIsArtifyLoading,
  setIsArtifyLoading,
} from './context.js'

beforeEach(() => {
  setIsArtifyLoading(false)
})

describe('context.js 的跨模块读写口', () => {
  it('isArtifyLoading 通过 get/set 读写一致（import 绑定只读，必须走 setter）', () => {
    expect(getIsArtifyLoading()).toBe(false)
    setIsArtifyLoading(true)
    expect(getIsArtifyLoading()).toBe(true)
    setIsArtifyLoading(false)
    expect(getIsArtifyLoading()).toBe(false)
  })

  it('环境旗标在无 query、无 electronAPI 时取默认值（假宿主最朴素形态）', () => {
    expect(artify_inject).toBeNull() // 无 ?artify_inject=
    expect(artify_playground).toBe(false) // 无 ?artify_playground=true
    expect(typeof isIframe).toBe('boolean') // happy-dom 顶层 → false
    expect(isElectron).toBe(false) // 无 window.electronAPI
  })

  it('isElectron 在无 electronAPI 时为 false（真机 ComfyUI 页有 preload 注入 → true，该路径由 W18 端到端覆盖）', () => {
    // 注：想在本文件里验"有 electronAPI → true"需要 vi.resetModules() + 动态 import 拿新实例，
    // 而模块实例被 vitest 缓存（带 query 的 import 也不可靠）。真机路径交给 W18（真产物 + electronAPI 桩）。
    expect(isElectron).toBe(false)
  })
})
