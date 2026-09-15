/**
 * 提示词库（S6b）——纯数据层
 *
 * 内置分词条库（本地打包，无网络依赖）+ 自定义条目（localStorage）。
 * 面板选择 → 回填目标（note 文本 / 改写指令 / 生图输入）。
 *
 * ## 组织方式（2026-09 重写：按工作流分类，而不是按"词性"分类）
 *
 * 面板是「分类头 + 可点片段」，点击即把 `text` **插入提示词**，`hint` 只作 tooltip
 * ——所以：**能直接用的片段/模板放 text，写法规则与适用模型放 hint**。
 *
 * 分类顺序即使用顺序：先定模型档（决定要不要写质量词/负面词），再按模态取骨架，
 * 最后才是通用风格词。五大模态全覆盖：文生图 / 文生视频 / 图生视频 / 图生图 / 图像编辑。
 *
 * ## 内容来源（不臆造）
 *
 * - 本应用内置技能（`src/main/artifylab/public/workbench-skills/`）：
 *   `prompt-engineering`、`flux-image-best-practices`、`krea2-txt2img`、`anima-base`、
 *   `krea2-identity-edit`、`h3-prompt-writing`、`minimax-h3-video`、`wan-t2v-video`、
 *   `wan-flf-video`、`wan-scail-replacement`、`ltxv2-video`、`video-extend`、`director`、
 *   `model-compatibility`、`model-registry`
 * - 社区方法论：`cclank/lanshu-awesome-ai-video-kit`（视频 8 要素骨架 / 运镜词典 /
 *   约束词清单 / 每模型官方公式，每周自动巡检 32 个官方端点对抗版本漂移）、
 *   `ZHO-ZHO-ZHO/ZHO-nano-banana-Creation`、`PicoTrex/Awesome-Nano-Banana-images`、
 *   `ZeroLu/awesome-seedance`、`EvoLinkAI/awesome-gpt-image-2-prompts`
 * - 编辑类"先锁不变项再写唯一改动"与五个动作词（Add/Change/Make/Remove/Replace）
 *   来自 Nano Banana / Qwen-Image-Edit 社区实测共识
 *
 * 模型分档是这份库的重点：**Flux / Krea2-Turbo / Qwen-Edit 不吃质量词与负面词**
 * （cfg=1 的蒸馏模型），**SD1.5 / SDXL / Anima / WAN 才是必需负面**。写错档位等于白写。
 */

const CUSTOM_KEY = 'artify.canvas.prompts.custom.v1'

/**
 * 内置库：分类 → 条目 [{text, hint?}]
 *
 * text = 可直接插入提示词的内容（片段 / 带 {} 占位符的模板 / 完整负面词串）
 * hint = 写法规则、适用模型、参数联动（面板 tooltip）
 */
export function builtinLibrary() {
  return [
    // ═══════════════════ 一、先定模型档 ═══════════════════
    {
      category: '① 模型分档（先看这条再挑词）',
      items: [
        {
          text: 'masterpiece, best quality, ultra detailed, 8k, sharp focus',
          hint: '质量前缀 → 只给 SD1.5 / SDXL / Anima 系。Flux / Krea2 / Qwen 系不吃这些填充词，写了只是浪费 token',
        },
        {
          text: '(worst quality, low quality:1.2), blurry, jpeg artifacts, deformed, bad anatomy, bad hands',
          hint: '通用负面 → SD1.5 / SDXL / Anima 必需。Flux 没有负面字段；Krea2-Turbo / Qwen-Edit 是 cfg=1 蒸馏，负面基本无效',
        },
        {
          text: 'worst quality, low quality, score_1, score_2, score_3, bad anatomy, bad hands, missing fingers, extra fingers, duplicate, text, watermark, signature',
          hint: 'Anima 专用负面（base 模式 cfg>1 才有意义；Turbo 12 步 cfg1 可留空）',
        },
        {
          text: 'static, details are unclear, subtitles, worst quality, low quality, JPEG compression artifacts, deformed, disfigured, distorted limbs, merged fingers, motionless image, cluttered background',
          hint: '视频负面（WAN 2.2 **必需**）。motionless image 专治"视频出成静止图"；别整段抄给 Flux/LTX/H3',
        },
        {
          text: 'natural skin texture, bare face, fresh-faced',
          hint: 'Flux 没有负面 → 用正向替代「no makeup」',
        },
        { text: 'sharp focus, crisp details, tack-sharp', hint: 'Flux 正向替代「no blur」' },
        { text: 'empty, deserted, solitary', hint: 'Flux 正向替代「no people」' },
        { text: 'clean surfaces, unmarked, pristine', hint: 'Flux 正向替代「no text」' },
        {
          text: 'single full-frame photograph, no diptych, split screen or collage',
          hint: 'Krea2 能用的少数负面：编辑/生成时压掉拼贴分屏（放在负面槽做安全兜底）',
        },
      ],
    },

    // ═══════════════════ 二、文生图 ═══════════════════
    {
      category: '② 文生图·骨架与三条铁律',
      items: [
        {
          text: '{主体} + {动作} + {媒介/风格} + {环境} + {光照} + {镜头/技术}',
          hint: '自然语言模型公式（Flux / Krea2 / Qwen / Seedream）：词序=权重，前置优先；30–80 词最佳，可到 512 token',
        },
        {
          text: '(masterpiece:1.2), {主体}, {主体细节}, {动作}, {环境}, {构图}, {光照}, {风格/媒介}, {技术质量}',
          hint: '标签式模型公式（SD1.5 / SDXL / Anima）：按此顺序写，越靠前权重越高',
        },
        {
          text: 'lit by soft window light from the left, casting gentle shadows',
          hint: '铁律 1：**光照影响最大**，必须显式写（只写主体、不写光 —— 结果最不可控）',
        },
        {
          text: '35mm color film photography, harsh direct on-camera flash, authentic film grain',
          hint: '铁律 2：用**器材/胶片规格**做风格锚点，比 "realistic photo" 这类抽象词稳定得多',
        },
        {
          text: 'shot on 85mm f/1.8, shallow depth of field, soft bokeh background',
          hint: '铁律 3：镜头参数是真指令（焦段/光圈/景深），Krea2 尤其吃这套',
        },
      ],
    },
    {
      category: '③ 文生图·自然语言式（Flux / Krea2 / Qwen）',
      items: [
        {
          text: '{主体+动作}, mid-stride through dense forest, low vantage point, golden hour backlight through canopy, raw film grain, monochrome ink wash style',
          hint: 'Krea2 六块堆叠：主体+动作 / 机位 / 光源 / 材质 / 命名风格。**3–6 个具体短语**，禁质量词、禁完整句、禁标签堆砌',
        },
        {
          text: 'Shot on 85mm f/1.8, Rembrandt lighting from camera left, film grain at ISO 800',
          hint: 'Krea2 把相机参数当**真指令**（独有优势）：焦段/光位/ISO 都照做',
        },
        {
          text: 'neon sign reading "OPEN"',
          hint: '图内文字：引号包住 1–2 个词。Qwen-Image / Flux.2 / GPT-Image 系文字渲染最强；Krea2 也支持',
        },
        {
          text: 'volumetric light beams through mist, dust particles in the air',
          hint: '自然语言模型写"光照"的首选：体积光 + 悬浮颗粒',
        },
        {
          text: 'golden hour backlight, rim light separating the subject from the background',
          hint: '人物类最稳组合：黄金时刻逆光 + 轮廓光分离主体',
        },
        {
          text: 'soft overcast daylight, low contrast, muted tones',
          hint: '阴天柔光：日系清淡、低对比',
        },
        {
          text: 'moody chiaroscuro, single desk lamp, deep shadows',
          hint: '明暗对比：伦勃朗式单光源、暗部厚重',
        },
        {
          text: 'clean negative space, uncluttered background, centered composition',
          hint: '产品/海报类：留白 + 居中，给后期文字排版留位置',
        },
        {
          text: 'matte ceramic surface, brushed metal, subtle reflection',
          hint: '材质词比 "premium / 高级感" 这类抽象词有效——模型只认可见细节',
        },
      ],
    },
    {
      category: '④ 文生图·标签式（SD1.5 / SDXL / Anima）',
      items: [
        {
          text: 'masterpiece, best quality, score_7, safe, highres, official art, 1girl, solo, @artist name, clean lineart, detailed eyes, soft shading',
          hint: 'Anima 顺序：质量 → 评分 → 数量 → 画师(@artist name) → 风格标签，再补 2–4 句自然语言。标签小写+空格，score_7 例外',
        },
        {
          text: '(keyword:1.3)',
          hint: '加权语法。有效域 0–2，>1.5 常出伪影；冲突词（亮+暗同时加权）会让模型混乱',
        },
        { text: '[keyword]', hint: '降权（约 0.9）。比写 "no xxx / less xxx" 更可靠' },
        { text: 'BREAK', hint: '超过 77 token 必须用 BREAK 分块，否则被静默截断（看不到报错）' },
        {
          text: 'beautiful detailed eyes, detailed face, clean lineart, soft shading',
          hint: '动漫向细节标签',
        },
        {
          text: 'dynamic pose, from below, dutch angle',
          hint: '构图要用标签（标签式模型别写整句）',
        },
        {
          text: 'photorealistic, RAW photo, DSLR, 8k uhd, film grain, Fujifilm XT3',
          hint: '写实向标签（SDXL 有效）。Flux/Krea2 请改写具体器材描述（见 ③ 铁律 2）',
        },
      ],
    },

    // ═══════════════════ 三、视频 ═══════════════════
    {
      category: '⑤ 文生视频·T2V（WAN / LTX / H3）',
      items: [
        {
          text: '{主体} {运动动词} in {场景}, {机位运动}, {光照}, cinematic, {节奏}',
          hint: '导演级 8 要素骨架：主体 / 动作 / 场景 / 运镜 / 光影 / 风格 / 约束 / 节奏。**只写静态画面 = 出来是静止视频**',
        },
        {
          text: 'A woman slowly walks through a blooming cherry blossom garden, petals drifting in the breeze, soft sunlight filtering through branches, cinematic slow motion',
          hint: 'WAN 官方示例：必须有运动动词 + 环境动态（花瓣/风/光），只写 "woman in garden" 会失败',
        },
        {
          text: 'the camera pushes in with small amplitude at slow speed toward {焦点}',
          hint: '运镜三要素：运动类型 + 幅度(small/large) + 速度(slow/fast)。写成句内自然动作，别堆标签尾缀',
        },
        {
          text: 'tracking shot following the subject as they walk',
          hint: '运镜类型：Tracking Shot（跟拍）',
        },
        { text: 'arc shot around the subject', hint: '运镜类型：Arc Shot（环绕）' },
        { text: 'static shot, locked-off camera', hint: '固定机位：强调主体自身运动时用' },
        { text: 'POV shot, first-person perspective', hint: '主观视角' },
        {
          text: 'the camera pans left to reveal {新信息}',
          hint: '摇镜 + 揭示：只改距离或小角度时，优先用运镜而不是切镜',
        },
        {
          text: '[Shot 2] At 00:03.500, the camera cuts to {下一镜}',
          hint: '切镜写法：首镜不加时间戳，后续切点严格递增且在总时长内；切镜必须引入新信息（主体/空间/状态/视角/时间）',
        },
        {
          text: 'overall_soundscape: ambient wind and distant birds; non_diegetic_music: soft piano',
          hint: 'H3 原生音频：声音也要写（soundscape / music 两段）',
        },
        {
          text: '16fps，81 帧≈5s（帧数 4n+1）',
          hint: '帧率口径别混用：WAN 16fps / 4n+1（81≈5s）；H3 24fps / 17k+5 且单镜≤15s；LTX 25fps / 8n+1',
        },
      ],
    },
    {
      category: '⑥ 图生视频·首尾帧与角色替换（I2V / FLF）',
      items: [
        {
          text: '{首帧状态} smoothly transforms into {末帧状态}, seamless transformation',
          hint: 'FLF 写法：描述**帧间路径**，不是两张静态图。变形用 smoothly transforms / seamlessly morphs / progresses into',
        },
        {
          text: 'gradually reshapes into {目标}, progressively narrowing the differences',
          hint: '渐进语言。⚠️ 别用 magical / enchanted / mystical —— 会生成字面闪光粒子',
        },
        {
          text: 'first-frame anchor → action onset → continuous development → result or reaction',
          hint: 'I2V 四段路径（H3 官方写法）：锚定首帧 → 动作起势 → 连续发展 → 结果或反应',
        },
        {
          text: 'keep the subject appearance, clothing and facial features consistent throughout the shot',
          hint: '防漂移/闪烁/形变：一致性要显式写；WAN 负面补 motionless image',
        },
        {
          text: 'subtle motion, minimal camera movement, slow drift',
          hint: '运动幅度是主旋钮：LTX strength≈0.6（设 1.0 会冻结成静态）、WAN shift 越低运动越强、Pusa noise_multipliers 趋 0 更贴源',
        },
        {
          text: 'strong dynamic motion, fast action, impactful movement',
          hint: '要大动作时用，并相应提高运动幅度参数',
        },
        {
          text: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
          hint: 'H3 首帧锚定指令（照抄）。FL2VA 写 "Picture 1 aligns with the 0.00-second mark; Picture 2 aligns with the S.SS-second mark"',
        },
        {
          text: 'Dress the person from the primary reference in the jacket shown in the second reference, keeping her face and pose unchanged.',
          hint: '换装/角色替换：PRIMARY=人物、SECONDARY=服装，**顺序不可互换**（换错是静默的）',
        },
      ],
    },

    // ═══════════════════ 四、图生图与编辑 ═══════════════════
    {
      category: '⑦ 图生图（img2img / 风格迁移）',
      items: [
        {
          text: 'convert {原图} into {目标}, keep {保留项}',
          hint: '提示词写**变化方向**。denoise 0.4–0.7 保构图微调，0.7–0.9 大幅重绘',
        },
        {
          text: 'same composition and pose, {风格} style, consistent mood, similar color palette',
          hint: '风格迁移只写风格与氛围，构图交给源图（别重新描述场景）',
        },
        {
          text: 'keep the composition, lighting and color temperature the same, change only the {改动}',
          hint: '不改构图时把保留项写明，模型才不会顺手改光改色',
        },
      ],
    },
    {
      category: '⑧ 图像编辑·指令式（Qwen-Edit / Flux.2 / 换装 / 局部重绘）',
      items: [
        {
          text: 'Keep the same person, facial features, hairstyle, clothing, pose and camera framing. Replace only the background with {新背景}.',
          hint: '**第一条规矩：先锁不变项，再写唯一改动**。不写保留项，模型会把整张图重建（脸/光/背景全漂）',
        },
        {
          text: 'Preserve exactly: {不变清单}. Edit only: {唯一改动}. Match the original lighting and color temperature.',
          hint: '编辑三段式（Preserve / Edit only / 输出约束）。一次只改一处，多改会把变量混在一起没法归因',
        },
        {
          text: 'Add a pair of sunglasses to {主体}',
          hint: '五个高遵循动作词：Add / Change / Make / Remove / Replace（实测指令遵循最高，优先用它们开头）',
        },
        {
          text: 'Replace the white top with a black t-shirt, match original lighting',
          hint: 'Replace 用法（换装/换物）',
        },
        { text: 'Remove the power lines from the background', hint: 'Remove 用法（去物）' },
        {
          text: 'Change the cloudy sky to a golden hour sunset',
          hint: 'Change 用法（改环境/光线）',
        },
        {
          text: 'The man wears his grey t-shirt. Same bedroom, same warm lighting, same clothing.',
          hint: 'Qwen-Edit 多轮一致性：**每一轮都要重新锚定服装与不变项**，否则逐轮漂移',
        },
        {
          text: 'Her head and body should be proportional and natural looking.',
          hint: '特写/拥抱类编辑必加比例约束，防"头变大"',
        },
        {
          text: '{要改成的内容}',
          hint: '局部重绘（inpaint）：prompt 只写**要变成什么**，不要描述原图；mask 外像素由节点保留',
        },
        {
          text: 'Do not enlarge her head, keep the same small natural size as in the original image.',
          hint: '编辑链越短越稳：控制在 4–5 层以内，超过会累积漂移（换脸/换装尤其明显）',
        },
        {
          text: '{image1} {image2} Use the {元素} from the second image above to replace {目标}. Blend edges and match lighting.',
          hint: '多参考图占位符写法：把图放在引用它的句子前，方便对照粘贴；每张参考图都要有明确分工',
        },
      ],
    },

    // ═══════════════════ 五、可直接填空的模板 ═══════════════════
    {
      category: '⑨ 完整模板（五类工作流，填空即用）',
      items: [
        {
          text: 'A photograph of {主体}, {动作}, in {环境}, lit by {光照}, shot on {镜头}, {技术质量}',
          hint: '文生图 · 自然语言式（Flux / Krea2 / Qwen）',
        },
        {
          text: '(masterpiece:1.2), (best quality:1.2), {主体}, {细节}, {动作}, {环境}, {构图}, {光照}, {风格}, 8k',
          hint: '文生图 · 标签式（SD1.5 / SDXL / Anima，配负面词使用）',
        },
        {
          text: '{主体} {运动动词} through {场景}, the camera {运镜} with {small/large} amplitude at {slow/fast} speed, {光照}, cinematic',
          hint: '文生视频（8 要素紧凑版；必须含运动与运镜）',
        },
        {
          text: '{首帧状态} smoothly transitions into {末帧状态}, {机位运动}, keep {主体} consistent, cinematic',
          hint: '图生视频 / 首尾帧（描述帧间路径）',
        },
        {
          text: 'Convert {原图} into {目标}, keep the same composition and lighting',
          hint: '图生图（风格迁移/改写，配 denoise 0.5–0.8）',
        },
        {
          text: 'Keep {不变项} exactly the same. Change only {改动}. Match the original lighting.',
          hint: '图像编辑（先锁后改；一次一处）',
        },
        {
          text: '[Shot 1] {描述} [Shot 2] At 00:03.500, the camera cuts to {描述}',
          hint: '多镜叙事：切镜引入新信息，切点时间戳严格递增',
        },
      ],
    },

    // ═══════════════════ 六、通用词库（模态无关，选填） ═══════════════════
    {
      category: '⑩ 风格与媒介',
      items: [
        { text: '水彩画风格，柔和笔触，纸张质感', hint: '水彩' },
        { text: '赛博朋克风格，霓虹灯光，雨夜反射', hint: '赛博朋克' },
        {
          text: '吉卜力动画风格，温暖色调，手绘质感',
          hint: '吉卜力（SD 系建议配 LoRA，自然语言模型可直接写）',
        },
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
      category: '⑪ 光照与氛围',
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
      category: '⑫ 构图与镜头',
      items: [
        { text: '特写肖像，浅景深，背景虚化', hint: '特写' },
        { text: '广角全景，宏大场景，史诗感构图', hint: '全景' },
        { text: '俯视 45 度角，产品摄影构图', hint: '产品' },
        { text: '第一人称视角，沉浸式构图', hint: 'POV（视频里对应 POV shot）' },
        { text: '三分法构图，主体居于交点', hint: '三分法' },
        { text: '对称构图，中心透视，仪式感', hint: '对称' },
        { text: '低角度仰拍，英雄视角，压迫感', hint: '仰拍' },
        { text: '微距镜头，极浅景深，细节纤毫毕现', hint: '微距' },
        { text: '35mm 纪实视角，自然抓拍感', hint: '纪实（竖屏视频建议 9:16 并给运动留头部空间）' },
        { text: '框架式构图，透过门窗取景', hint: '框景' },
      ],
    },
    {
      category: '⑬ 色彩与情绪',
      items: [
        { text: '莫兰迪色系，低饱和灰调，高级感', hint: '莫兰迪' },
        { text: '青橙色调，电影调色，冷暖对比', hint: '青橙（teal & orange）' },
        { text: '高饱和撞色，波普艺术配色', hint: '波普' },
        { text: '柔和粉彩，奶油色系，梦幻感', hint: '粉彩' },
        { text: '单色调摄影，深浅层次，去色处理', hint: '单色' },
        { text: '黑金配色，奢华质感，暗部细节', hint: '黑金' },
        { text: '宁静治愈的氛围，岁月静好', hint: '情绪：治愈' },
        { text: '紧张悬疑气氛，乌云压顶', hint: '情绪：悬疑' },
        { text: '史诗感，宏大叙事，气势磅礴', hint: '情绪：史诗' },
        { text: '梦幻超现实，漂浮元素，梦境逻辑', hint: '情绪：梦境' },
        { text: '忧郁诗意，细雨朦胧', hint: '情绪：忧郁' },
        { text: '活力四射，动感动势，速度线', hint: '情绪：动感' },
      ],
    },
    {
      category: '⑭ 人物与主体',
      items: [
        { text: '一位年轻女性，长发，穿白色连衣裙，微笑', hint: '女性肖像' },
        { text: '戴眼镜的科学家，实验服，专注神情', hint: '职业' },
        { text: '可爱的女孩，大眼睛，动漫风格', hint: '动漫（标签式模型写 1girl, solo）' },
        {
          text: '老年人面部特写，皱纹细节，故事感',
          hint: '老人（皮肤质感用 natural skin texture，别用 plastic skin）',
        },
        { text: '身穿铠甲的骑士，披风飘扬，持剑而立', hint: '骑士' },
        { text: '身着和服的女子，撑油纸伞，回眸', hint: '和服' },
        { text: '机械改造人，义体线条，冷光瞳孔', hint: '改造人' },
        { text: '奔跑中的少年，校服，动感模糊背景', hint: '少年' },
        { text: '一只橘猫，慵懒地趴在窗台，阳光洒落', hint: '动物' },
      ],
    },
    {
      category: '⑮ 场景与材质',
      items: [
        { text: '未来城市天际线，飞行器，摩天大楼', hint: '科幻' },
        { text: '森林深处的小木屋，炊烟，晨雾', hint: '童话' },
        { text: '日式庭院，枯山水，樱花飘落', hint: '和风' },
        { text: '雨后的老街，石板路反光，霓虹招牌', hint: '老街' },
        { text: '深海废墟，光柱穿透水面，鱼群环绕', hint: '深海' },
        { text: '雪山之巅，云海翻腾，日出金光', hint: '雪山' },
        { text: '图书馆内部，旋转楼梯，穹顶彩窗', hint: '图书馆' },
        { text: '玻璃质感，透明折射，焦散光斑', hint: '材质：玻璃' },
        { text: '织物纹理，亚麻质感，自然褶皱', hint: '材质：织物' },
        { text: '大理石纹理，金线裂纹，古典雕塑感', hint: '材质：大理石' },
        { text: '粘土质感，手作痕迹，柔和圆润', hint: '材质：粘土' },
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
