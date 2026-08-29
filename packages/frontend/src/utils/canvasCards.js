/**
 * 画布陈列卡片排布几何（纯函数，供注入脚本与单测共享）。
 *
 * 注入脚本把产物铺成 litegraph 陈列节点时用这里的算法：从当前视口
 * 右侧空白起排，列内向下堆叠，超出视口高度换列（瀑布式，官方
 * positionNodes 同构）。保持纯函数便于 vitest 直接断言几何。
 */

/** 卡片默认尺寸与间距（与注入脚本 drawImage 网格假设一致） */
export const CARD_WIDTH = 256
export const CARD_HEIGHT = 340
export const CARD_GAP = 24

/**
 * 计算一批卡片的摆放坐标。
 *
 * @param {Object} opts
 * @param {number} opts.count 卡片数量
 * @param {[number, number, number, number]} opts.visibleArea 视口可见区
 *   [x, y, w, h]（graph 坐标，来自 canvas.ds.visible_area）
 * @param {number} [opts.dpr] 设备像素比（visible_area 是物理像素，需换回逻辑像素）
 * @returns {{x:number,y:number,w:number,h:number}[]} 每张卡片的 pos/size
 */
export function layoutDisplayCards({ count, visibleArea, dpr = 1 }) {
  const dpi = Math.max(dpr || 1, 1)
  const [ax, ay, aw, ah] = visibleArea
  const stepX = CARD_WIDTH + CARD_GAP
  // 从视口右缘往左排：新卡片出现在当前视野内，无需用户平移
  const startX = ax + aw / dpi - count * stepX - CARD_GAP * 2
  const top = ay + CARD_GAP
  const bottomLimit = ay + ah / dpi - CARD_HEIGHT
  const cards = []
  let x = startX
  let y = top
  for (let i = 0; i < count; i++) {
    cards.push({ x, y, w: CARD_WIDTH, h: CARD_HEIGHT })
    y += CARD_HEIGHT + CARD_GAP
    if (y > bottomLimit) {
      y = top
      x += stepX
    }
  }
  return cards
}
