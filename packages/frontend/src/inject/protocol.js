/**
 * artify:* 桥协议常量——A 面（workbench iframe）与 C 面（inject 注入脚本）
 * 之间 postMessage 消息类型的唯一 home。
 *
 * 两侧同源 import：inject 侧相对路径（esbuild bundle），app 侧 @/inject/protocol.js
 * （vite alias）。改名在这里改，编译期两侧同时报错，不再静默断链。
 *
 * 消息流向：
 *  A→C（workbench → inject）: DISPLAY_CARD / GET_CANVAS_STATE / CANVAS_OPS /
 *                             CANVAS_EXECUTE / CARD_ATTACH
 *  C→A（inject → workbench）: CANVAS_STATE / CANVAS_OPS_RESULT / CANVAS_EXECUTE_RESULT
 *  （CARD_ATTACH 实际是 C→A 方向：card_bridge 把文件句柄回发给 embed 窗口，
 *   A→C 的 display-card 才是工作台产物落布的请求侧——见各调用点注释。）
 */
export const ARTIFY_MSG = {
  /** 工作台产物 → 宿主画布陈列卡片（payload: files[]） */
  DISPLAY_CARD: 'artify:display-card',
  /** 请求宿主画布当前状态摘要（无 payload） */
  GET_CANVAS_STATE: 'artify:get-canvas-state',
  /** 宿主画布状态摘要回推（payload: state） */
  CANVAS_STATE: 'artify:canvas-state',
  /** 画布编排指令（payload: ops[] + requestId + reason），需 ack */
  CANVAS_OPS: 'artify:canvas-ops',
  /** CANVAS_OPS 的 ack（payload: requestId + ok/result） */
  CANVAS_OPS_RESULT: 'artify:canvas-ops-result',
  /** 画布执行指令（payload: op + requestId），需 ack */
  CANVAS_EXECUTE: 'artify:canvas-execute',
  /** CANVAS_EXECUTE 的 ack（payload: requestId + ok/result） */
  CANVAS_EXECUTE_RESULT: 'artify:canvas-execute-result',
  /** 文件句柄回发给 embed 窗口（payload: files[]） */
  CARD_ATTACH: 'artify:card-attach',
}

/** 需要 requestId/ack 关联的请求类型 → 其 ack 类型 */
export const ARTIFY_ACK_OF = {
  [ARTIFY_MSG.CANVAS_OPS]: ARTIFY_MSG.CANVAS_OPS_RESULT,
  [ARTIFY_MSG.CANVAS_EXECUTE]: ARTIFY_MSG.CANVAS_EXECUTE_RESULT,
}

/** 判断某 message event 的 data 是否为 artify 协议消息 */
export function isArtifyMessage(data) {
  return !!data && typeof data.type === 'string' && data.type.startsWith('artify:')
}
