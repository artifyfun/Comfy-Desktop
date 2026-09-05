/**
 * 提示词库（S6b）——纯数据层
 *
 * 内置分词条库（本地打包，无网络依赖）+ 自定义条目（localStorage）。
 * 面板选择 → 回填目标（note 文本 / 改写指令 / 生图输入）。
 */

const CUSTOM_KEY = 'artify.canvas.prompts.custom.v1'

/**
 * 内置库：分类 → 条目 [{text, hint?}]
 *
 * 结构参照开源提示词库的通用分类法（质量/媒介/光照/构图/色彩/情绪/主体/
 * 场景/材质 + 负面词 + 模板句式 + 标签式词条），自然语言中文为主，
 * 另设英文标签类（Anima/Illustrious 系标签式模型直接可用）。
 */
export function builtinLibrary() {
  return [
    {
      category: '画质与质量',
      items: [
        { text: '杰作，最佳质量，超精细细节，8K 分辨率', hint: '通用质量前缀' },
        { text: '超高清细节，锐利对焦，专业级画质', hint: '高清' },
        { text: '电影级画质，胶片质感，宽银幕色彩', hint: '电影感' },
        { text: '获奖摄影作品，国家地理风格，纪实质感', hint: '摄影' },
        { text: '4K 壁纸级精细度，工程级渲染', hint: '渲染' },
        { text: 'artstation 趋势作品，概念设计级完成度', hint: '概念设计' },
      ],
    },
    {
      category: '风格与媒介',
      items: [
        { text: '水彩画风格，柔和笔触，纸张质感', hint: '水彩' },
        { text: '赛博朋克风格，霓虹灯光，雨夜反射', hint: '赛博朋克' },
        { text: '吉卜力动画风格，温暖色调，手绘质感', hint: '吉卜力' },
        { text: '黑白胶片摄影，高对比度，颗粒感', hint: '胶片' },
        { text: '低多边形 3D 渲染，等距视角，柔和配色', hint: 'low-poly' },
        { text: '油画风格，厚重笔触，伦勃朗式明暗', hint: '油画' },
        { text: '扁平插画风格，简洁色块，矢量质感', hint: '扁平插画' },
        { text: '像素艺术风格，16-bit 复古游戏画面', hint: '像素' },
        { text: '蒸汽波风格，粉紫渐变，复古未来主义', hint: '蒸汽波' },
        { text: '水墨画风格，留白意境，写意笔法', hint: '水墨' },
        { text: '浮世绘风格，木刻线条，和风配色', hint: '浮世绘' },
        { text: '3D 卡通渲染，皮克斯式角色造型，柔和布光', hint: '3D 卡通' },
        { text: '蒸汽朋克风格，黄铜机械，齿轮细节', hint: '蒸汽朋克' },
        { text: '极简主义设计，大量留白，单色调', hint: '极简' },
      ],
    },
    {
      category: '光照氛围',
      items: [
        { text: '黄金时刻光线，逆光轮廓，温暖光晕', hint: '黄昏' },
        { text: '柔和影棚光，均匀照明，专业人像', hint: '影棚' },
        { text: '体积光，丁达尔效应，尘埃颗粒', hint: '体积光' },
        { text: '月光下的雪夜，冷蓝色调，安静氛围', hint: '雪夜' },
        { text: '霓虹灯补光，品红青色对比，夜景人像', hint: '霓虹' },
        { text: '烛光暖调，明暗对比强烈，伦勃朗光', hint: '烛光' },
        { text: '阴天柔光，低对比，日系清新', hint: '阴天' },
        { text: '轮廓光勾勒主体，暗背景分离', hint: '轮廓光' },
        { text: '晨雾中的漫射光，空气透视层次', hint: '晨雾' },
        { text: '舞台追光，聚光灯效果，戏剧化阴影', hint: '舞台' },
      ],
    },
    {
      category: '构图与镜头',
      items: [
        { text: '特写肖像，浅景深，背景虚化', hint: '特写' },
        { text: '广角全景，宏大场景，史诗感构图', hint: '全景' },
        { text: '俯视 45 度角，产品摄影构图', hint: '产品' },
        { text: '第一人称视角，沉浸式构图', hint: 'POV' },
        { text: '三分法构图，主体居于交点', hint: '三分法' },
        { text: '对称构图，中心透视，仪式感', hint: '对称' },
        { text: '低角度仰拍，英雄视角，压迫感', hint: '仰拍' },
        { text: '微距镜头，极浅景深，细节纤毫毕现', hint: '微距' },
        { text: '鱼眼镜头，桶形畸变，夸张透视', hint: '鱼眼' },
        { text: '剪影构图，逆光主体，极简背景', hint: '剪影' },
        { text: '框架式构图，透过门窗取景', hint: '框景' },
        { text: '35mm 纪实视角，自然抓拍感', hint: '纪实' },
      ],
    },
    {
      category: '色彩色调',
      items: [
        { text: '莫兰迪色系，低饱和灰调，高级感', hint: '莫兰迪' },
        { text: '高饱和撞色，波普艺术配色', hint: '波普' },
        { text: '青橙色调，电影调色，冷暖对比', hint: '青橙' },
        { text: '单色调摄影，深浅层次，去色处理', hint: '单色' },
        { text: '暖金色黄昏调，怀旧滤镜', hint: '暖金' },
        { text: '冷蓝科技感配色，金属质感', hint: '冷蓝' },
        { text: '柔和粉彩，奶油色系，梦幻感', hint: '粉彩' },
        { text: '黑金配色，奢华质感，暗部细节', hint: '黑金' },
      ],
    },
    {
      category: '情绪氛围',
      items: [
        { text: '宁静治愈的氛围，岁月静好', hint: '治愈' },
        { text: '孤独感，空旷场景，渺小人物', hint: '孤独' },
        { text: '紧张悬疑气氛，乌云压顶', hint: '悬疑' },
        { text: '温馨家庭氛围，暖黄灯光', hint: '温馨' },
        { text: '史诗感，宏大叙事，气势磅礴', hint: '史诗' },
        { text: '梦幻超现实，漂浮元素，梦境逻辑', hint: '梦境' },
        { text: '忧郁诗意，细雨朦胧', hint: '忧郁' },
        { text: '活力四射，动感动势，速度线', hint: '动感' },
      ],
    },
    {
      category: '人物与主体',
      items: [
        { text: '一位年轻女性，长发，穿白色连衣裙，微笑', hint: '女性肖像' },
        { text: '戴眼镜的科学家，实验服，专注神情', hint: '职业' },
        { text: '可爱的女孩，大眼睛，动漫风格', hint: '动漫' },
        { text: '老年人面部特写，皱纹细节，故事感', hint: '老人' },
        { text: '身穿铠甲的骑士，披风飘扬，持剑而立', hint: '骑士' },
        { text: '身着和服的女子，撑油纸伞，回眸', hint: '和服' },
        { text: '机械改造人，义体线条，冷光瞳孔', hint: '改造人' },
        { text: '奔跑中的少年，校服，动感模糊背景', hint: '少年' },
        { text: '弹吉他的音乐人，舞台灯下，剪影', hint: '音乐人' },
        { text: '一只橘猫，慵懒地趴在窗台，阳光洒落', hint: '动物' },
      ],
    },
    {
      category: '场景环境',
      items: [
        { text: '未来城市天际线，飞行器，摩天大楼', hint: '科幻' },
        { text: '森林深处的小木屋，炊烟，晨雾', hint: '童话' },
        { text: '日式庭院，枯山水，樱花飘落', hint: '和风' },
        { text: '太空站内部，舷窗看地球，科幻内饰', hint: '太空' },
        { text: '雨后的老街，石板路反光，霓虹招牌', hint: '老街' },
        { text: '沙漠中的遗迹，风蚀石柱，黄昏', hint: '遗迹' },
        { text: '深海废墟，光柱穿透水面，鱼群环绕', hint: '深海' },
        { text: '雪山之巅，云海翻腾，日出金光', hint: '雪山' },
        { text: '赛博朋克夜市，全息广告，蒸汽小吃摊', hint: '夜市' },
        { text: '图书馆内部，旋转楼梯，穹顶彩窗', hint: '图书馆' },
      ],
    },
    {
      category: '材质与质感',
      items: [
        { text: '玻璃质感，透明折射，焦散光斑', hint: '玻璃' },
        { text: '金属拉丝表面，镜面反射，工业质感', hint: '金属' },
        { text: '织物纹理，亚麻质感，自然褶皱', hint: '织物' },
        { text: '大理石纹理，金线裂纹，古典雕塑感', hint: '大理石' },
        { text: '粘土质感，手作痕迹，柔和圆润', hint: '粘土' },
        { text: '全息投影质感，半透明发光，扫描线', hint: '全息' },
      ],
    },
    {
      category: '负面提示词',
      items: [
        {
          text: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, blurry',
          hint: '通用负面（SD/Illustrious 系）',
        },
        {
          text: 'blurry, lowres, deformed, disfigured, extra limbs, mutated hands, poorly drawn face, bad proportions, watermark, text',
          hint: '简版负面',
        },
        {
          text: 'text, watermark, logo, signature, username, frame, border',
          hint: '去文字水印',
        },
        { text: 'oversaturated, overexposed, underexposed, low contrast', hint: '曝光色彩问题' },
      ],
    },
    {
      category: '模板句式',
      items: [
        {
          text: '{主体}，{风格}风格，{光照}，{构图}，最佳质量，超精细细节',
          hint: '通用四段式（替换花括号）',
        },
        {
          text: 'A photograph of {主体}, {光照}, shallow depth of field, 8k, highly detailed',
          hint: '摄影模板',
        },
        {
          text: '{主体}, concept art, trending on artstation, volumetric lighting, hyper detailed',
          hint: '概念设计模板',
        },
        {
          text: '{{主体}}的插画，{情绪}氛围，{色彩}色调，扁平风格',
          hint: '插画模板',
        },
      ],
    },
    {
      category: '标签式词条（英文）',
      items: [
        { text: 'masterpiece, best quality, ultra-detailed, 8k', hint: '质量前缀' },
        { text: '1girl, solo, long hair, looking at viewer, smile', hint: '人物基础' },
        { text: 'cinematic lighting, rim light, volumetric light', hint: '光照' },
        { text: 'upper body, close-up, dynamic angle, depth of field', hint: '构图' },
        { text: 'detailed background, cityscape, night, neon lights', hint: '场景' },
        { text: 'simple background, white background', hint: '简洁背景' },
        { text: 'chibi, chibi-style', hint: 'Q 版' },
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
