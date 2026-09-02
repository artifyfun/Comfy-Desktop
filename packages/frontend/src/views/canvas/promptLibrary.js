/**
 * 提示词库（S6b）——纯数据层
 *
 * 内置分词条库（本地打包，无网络依赖）+ 自定义条目（localStorage）。
 * 面板选择 → 回填目标（note 文本 / 改写指令 / 生图输入）。
 */

const CUSTOM_KEY = 'artify.canvas.prompts.custom.v1'

/** 内置库：分类 → 条目 [{text, hint?}] */
export function builtinLibrary() {
  return [
    {
      category: '画质风格',
      items: [
        { text: '杰作，最佳质量，超精细细节，8K 分辨率', hint: '通用质量前缀' },
        { text: '水彩画风格，柔和笔触，纸张质感', hint: '水彩' },
        { text: '赛博朋克风格，霓虹灯光，雨夜反射', hint: '赛博朋克' },
        { text: '吉卜力动画风格，温暖色调，手绘质感', hint: '吉卜力' },
        { text: '黑白胶片摄影，高对比度，颗粒感', hint: '胶片' },
        { text: '低多边形 3D 渲染，等距视角，柔和配色', hint: 'low-poly' },
      ],
    },
    {
      category: '光照氛围',
      items: [
        { text: '黄金时刻光线，逆光轮廓，温暖光晕', hint: '黄昏' },
        { text: '柔和影棚光，均匀照明，专业人像', hint: '影棚' },
        { text: '体积光，丁达尔效应，尘埃颗粒', hint: '体积光' },
        { text: '月光下的雪夜，冷蓝色调，安静氛围', hint: '雪夜' },
      ],
    },
    {
      category: '构图视角',
      items: [
        { text: '特写肖像，浅景深，背景虚化', hint: '特写' },
        { text: '广角全景，宏大场景，史诗感构图', hint: '全景' },
        { text: '俯视 45 度角，产品摄影构图', hint: '产品' },
        { text: '第一人称视角，沉浸式构图', hint: 'POV' },
      ],
    },
    {
      category: '人物主体',
      items: [
        { text: '一位年轻女性，长发，穿白色连衣裙，微笑', hint: '女性肖像' },
        { text: '戴眼镜的科学家，实验服，专注神情', hint: '职业' },
        { text: '可爱的女孩，大眼睛，动漫风格', hint: '动漫' },
        { text: '老年人面部特写，皱纹细节，故事感', hint: '老人' },
      ],
    },
    {
      category: '场景环境',
      items: [
        { text: '未来城市天际线，飞行器，摩天大楼', hint: '科幻' },
        { text: '森林深处的小木屋，炊烟，晨雾', hint: '童话' },
        { text: '日式庭院，枯山水，樱花飘落', hint: '和风' },
        { text: '太空站内部，舷窗看地球，科幻内饰', hint: '太空' },
      ],
    },
  ]
}

/** 读自定义条目（容忍坏档） */
export function loadCustomPrompts(storage = null) {
  const raw = storage ? storage.getItem(CUSTOM_KEY) : null
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr
          .filter((x) => x && typeof x.text === 'string' && x.text.trim())
          .map((x) => ({ text: x.text, hint: x.hint || '' }))
      : []
  } catch {
    return []
  }
}

/** 存自定义条目 */
export function saveCustomPrompts(items, storage = null) {
  if (!storage) return
  try {
    storage.setItem(CUSTOM_KEY, JSON.stringify(items || []))
  } catch {
    /* 容量满静默 */
  }
}

/** 导入 JSON：数组 [{text,hint?}] 或 {prompts:[...]} 或纯字符串数组 */
export function parseImportedPrompts(json) {
  const parsed = JSON.parse(json)
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.prompts)
      ? parsed.prompts
      : null
  if (!list) throw new Error('unrecognized prompts format')
  return list
    .map((x) => (typeof x === 'string' ? { text: x, hint: '' } : x))
    .filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ text: x.text, hint: String(x.hint || '') }))
}

/** 合并去重（按 text） */
export function mergePrompts(base, incoming) {
  const seen = new Set(base.map((x) => x.text))
  return [...base, ...incoming.filter((x) => !seen.has(x.text))]
}

/** 搜索：text/hint 模糊匹配 */
export function searchPrompts(lib, q) {
  const kw = String(q || '')
    .trim()
    .toLowerCase()
  if (!kw) return lib
  return lib
    .map((cat) => ({
      ...cat,
      items: cat.items.filter(
        (it) => it.text.toLowerCase().includes(kw) || (it.hint || '').toLowerCase().includes(kw),
      ),
    }))
    .filter((cat) => cat.items.length)
}
