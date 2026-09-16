/**
 * 画布用法指南（Canvas Guide）——纯数据层
 *
 * 定位：**节点类型 × 场景玩法**百科，不是手势操作说明（手势在快捷键面板）。
 * 每页 = 标题 + 一句话定位 + 步骤 + 一张声明式示意图（diagram spec）。
 * 示意图不存 SVG 字符串：这里只描述「节点卡片 + 连线 + 手势箭头」的几何，
 * 渲染统一由 CanvasGuideModal.vue 负责——样式一处调，全部页面跟着变。
 *
 * diagram spec：
 *   nodes: [{ x, y, w, h, kind, label }]   kind: image|app|out|note|frame|shot|video|audio
 *   links: [{ from, to, dash?, label? }]   from/to = nodes 下标，默认右缘中点 → 左缘中点贝塞尔
 *   gestures: [{ type: 'drag'|'click', x1, y1, x2?, y2?, label? }]
 *
 * 双语：zh 为主（与 promptLibrary.js 同惯例），en 同步给出；取当前语言回退 zh。
 */

const PAGES = [
  // ═══════════════ A. 节点类型 ═══════════════
  {
    id: 'node-image',
    icon: 'fas fa-image',
    title: { zh: '图片节点', en: 'Image Node' },
    tip: {
      zh: '画布上的图片素材，一切生成的起点与产物。',
      en: 'Image material on the canvas — the source and product of everything.',
    },
    steps: {
      zh: [
        '把图片文件拖进画布，或 Ctrl/⌘+V 直接粘贴剪贴板图片',
        '悬停图片唤出工具栏：旋转、裁剪、放大、拆分、下载',
        '右键图片可反推提示词、扩图、局部重绘、图生视频',
        '连一条线到 App 节点，图片就变成它的工作流输入',
      ],
      en: [
        'Drag an image file onto the canvas, or paste with Ctrl/⌘+V',
        'Hover an image for its toolbar: rotate, crop, upscale, split, download',
        'Right-click for prompt reverse, outpaint, inpaint, image-to-video',
        'Link it to an App node to use it as workflow input',
      ],
    },
    diagram: {
      nodes: [
        { x: 24, y: 56, w: 64, h: 64, kind: 'image', label: '🖼' },
        { x: 148, y: 56, w: 64, h: 64, kind: 'app', label: 'App' },
        { x: 236, y: 56, w: 60, h: 64, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 1, label: { zh: '作输入', en: 'input' } },
        { from: 1, to: 2 },
      ],
      gestures: [],
    },
  },
  {
    id: 'node-app',
    icon: 'fas fa-cube',
    title: { zh: 'App 节点（工作流应用）', en: 'App Node (Workflow App)' },
    tip: {
      zh: '把应用库里带工作流的应用摆上画布，填参数、点运行。',
      en: 'Place a workflow app from the library, fill params, hit run.',
    },
    steps: {
      zh: [
        '工具栏「+」或右键菜单 → 应用节点，从应用库挑选（仅列带工作流的应用）',
        '悬停节点 → 参数面板：提示词、采样参数等表单即时可改',
        '点 ▶ 运行，状态实时变化；完成后产物图片自动落在节点右侧',
        '产物与节点自动连线溯源；「从此重跑」可只重跑它的下游',
      ],
      en: [
        'Toolbar "+" or right-click → App node; the picker lists apps that ship a workflow',
        'Hover the node → params panel: edit prompt and sampling form fields in place',
        'Click ▶ to run; output images land right beside the node when done',
        'Outputs auto-link back for provenance; "Rerun from here" re-runs downstream only',
      ],
    },
    diagram: {
      nodes: [
        { x: 36, y: 46, w: 88, h: 88, kind: 'app', label: 'App' },
        { x: 190, y: 40, w: 62, h: 56, kind: 'out', label: '' },
        { x: 190, y: 110, w: 62, h: 56, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 1 },
        { from: 0, to: 2 },
      ],
      gestures: [{ type: 'click', x: 44, y: 122, label: '▶' }],
    },
  },
  {
    id: 'node-media',
    icon: 'fas fa-film',
    title: { zh: '视频 / 音频节点', en: 'Video / Audio Node' },
    tip: {
      zh: '动态素材占位，可作视频工作流的输入。',
      en: 'Dynamic media placeholders usable as video workflow inputs.',
    },
    steps: {
      zh: [
        '右键画布 → 创建 → 视频 / 音频，先落占位节点再上传素材',
        '悬停节点 → 上传按钮换源；视频可直接播放预览',
        '视频节点可抓取首帧 / 尾帧 / 当前帧为图片节点',
        '拖入视频/音频文件到画布，同样会自动落布',
      ],
      en: [
        'Right-click canvas → Create → Video / Audio, then upload the media',
        'Hover the node → replace source; videos preview inline',
        'Grab the first / last / current frame of a video as an image node',
        'Dragging video or audio files onto the canvas works the same',
      ],
    },
    diagram: {
      nodes: [
        { x: 30, y: 56, w: 84, h: 62, kind: 'video', label: '▶' },
        { x: 176, y: 56, w: 62, h: 62, kind: 'image', label: '🖼' },
      ],
      links: [{ from: 0, to: 1, label: { zh: '取帧', en: 'frame' } }],
      gestures: [{ type: 'click', x: 102, y: 108, label: '⏮' }],
    },
  },
  {
    id: 'node-note',
    icon: 'fas fa-note-sticky',
    title: { zh: '便签', en: 'Note' },
    tip: {
      zh: '画布上的提示词草稿纸，能直接变成图。',
      en: 'A prompt scratchpad that can turn straight into an image.',
    },
    steps: {
      zh: [
        '工具栏「+」→ 便签；双击便签编辑文字',
        '悬停工具栏：换颜色、调字号',
        '「AI 改写」让 AI 润色这段提示词',
        '「生成图片」直接按便签内容生图；「存入提示词库」复用',
      ],
      en: [
        'Toolbar "+" → Note; double-click to edit its text',
        'Hover toolbar: change color and font size',
        '"AI Rewrite" polishes the prompt for you',
        '"Generate Image" renders it directly; save it into the prompt library to reuse',
      ],
    },
    diagram: {
      nodes: [{ x: 56, y: 48, w: 92, h: 84, kind: 'note', label: 'a cat in rain' }],
      links: [],
      gestures: [{ type: 'drag', x1: 150, y1: 48, x2: 236, y2: 90, label: '✨' }],
    },
  },
  {
    id: 'node-frame',
    icon: 'fas fa-border-none',
    title: { zh: '画框（Frame 分区）', en: 'Frame' },
    tip: {
      zh: '给画布划地盘：按角色、场景或批次组织内容。',
      en: 'Fence off canvas regions by character, scene, or batch.',
    },
    steps: {
      zh: [
        '右键画布 → 画框，在原地创建虚线分区',
        '拖动图片/节点进框，随框一起移动收纳',
        '双击框标题重命名（如「主角」「场景B」）',
        '配合小地图俯瞰全部分区，快速定位',
      ],
      en: [
        'Right-click canvas → Frame to create a dashed region in place',
        'Drag images/nodes into it; they travel with the frame',
        'Double-click the title to rename it (e.g. "Hero", "Scene B")',
        'Use the minimap to overview every region at a glance',
      ],
    },
    diagram: {
      nodes: [
        { x: 26, y: 32, w: 150, h: 120, kind: 'frame', label: 'Scene B' },
        { x: 42, y: 66, w: 52, h: 52, kind: 'image', label: '' },
        { x: 106, y: 66, w: 52, h: 52, kind: 'image', label: '' },
      ],
      links: [],
      gestures: [],
    },
  },
  {
    id: 'node-shot',
    icon: 'fas fa-clapperboard',
    title: { zh: '分镜（Shot 卡片）', en: 'Shot Card' },
    tip: {
      zh: '带序号的脚本卡片，把叙事拆成一格一格。',
      en: 'Numbered script cards that break a story into beats.',
    },
    steps: {
      zh: [
        '工具栏「分镜」按钮创建卡片，自动编号 #1 #2 #3…',
        '在卡片里写这一镜的画面描述',
        '按分镜顺序摆放，形成故事板',
        '选中后「发送到工作台」进入完整制作流程',
      ],
      en: [
        'Toolbar "Shot" adds a card, auto-numbered #1 #2 #3…',
        'Write the beat description inside the card',
        'Arrange cards in order to form a storyboard',
        'Select and "Send to Workbench" for full production',
      ],
    },
    diagram: {
      nodes: [
        { x: 24, y: 52, w: 80, h: 72, kind: 'shot', label: '#1' },
        { x: 118, y: 52, w: 80, h: 72, kind: 'shot', label: '#2' },
        { x: 212, y: 52, w: 80, h: 72, kind: 'shot', label: '#3' },
      ],
      links: [],
      gestures: [],
    },
  },

  // ═══════════════ B. 场景玩法 ═══════════════
  {
    id: 'scene-txt2img',
    icon: 'fas fa-wand-magic-sparkles',
    title: { zh: '文生图 / 图生图', en: 'Text-to-Image / Image-to-Image' },
    tip: {
      zh: '最常用的两条生成路径：纯提示词，或图 + 提示词。',
      en: 'The two everyday generation paths: prompt only, or image + prompt.',
    },
    steps: {
      zh: [
        '文生图：便签写提示词 → 便签工具栏「生成图片」；或直接添加 App 节点填词运行',
        '图生图：从图片的参考条点「+」选类型，新节点自动与图片连线',
        '图片 → App 节点连线的含义：这张图作为它的工作流输入（参考图）',
        '产物继续向右连线，一版一版迭代下去',
      ],
      en: [
        'T2I: write a prompt on a note → "Generate Image"; or add an App node directly',
        'I2I: click "+" on the image\'s reference bar and pick a node type — it auto-links',
        'An image → App node link means: this image is the workflow\'s input reference',
        'Keep linking outputs rightward to iterate version after version',
      ],
    },
    diagram: {
      nodes: [
        { x: 20, y: 84, w: 62, h: 62, kind: 'image', label: '🖼' },
        { x: 30, y: 16, w: 62, h: 44, kind: 'note', label: 'prompt' },
        { x: 138, y: 60, w: 70, h: 74, kind: 'app', label: 'App' },
        { x: 246, y: 60, w: 56, h: 74, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 2, label: { zh: '参考图', en: 'ref' } },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
      gestures: [],
    },
  },
  {
    id: 'scene-inpaint',
    icon: 'fas fa-brush',
    title: { zh: '局部重绘（蒙版）', en: 'Inpaint (Mask)' },
    tip: {
      zh: '图不错，只改一块：涂哪里、改哪里。',
      en: 'Good image, one bad region: brush it, change it.',
    },
    steps: {
      zh: [
        '右键图片 → 局部重绘，打开蒙版编辑弹窗',
        '用笔刷涂抹要修改的区域（橡皮擦可擦除涂多的部分）',
        '滚轮缩放、空格拖拽平移大图，涂抹边缘更精细',
        '下方输入重绘提示词（描述涂抹区该变成什么），提交后发工作台执行',
      ],
      en: [
        'Right-click an image → Inpaint to open the mask editor',
        'Brush over the region to change (eraser fixes over-brushing)',
        'Wheel to zoom, space-drag to pan for precise edges',
        'Type what the region should become, then submit to the workbench',
      ],
    },
    diagram: {
      nodes: [
        { x: 44, y: 44, w: 96, h: 88, kind: 'image', label: '🖼' },
        { x: 208, y: 52, w: 72, h: 72, kind: 'out', label: '' },
      ],
      links: [{ from: 0, to: 1, dash: true, label: { zh: '仅改涂抹区', en: 'masked only' } }],
      gestures: [{ type: 'drag', x1: 70, y1: 70, x2: 112, y2: 104, label: '🖌' }],
    },
  },
  {
    id: 'scene-variations',
    icon: 'fas fa-images',
    title: { zh: '一图多变', en: 'One Image, Many Tricks' },
    tip: {
      zh: '右键菜单就是图片的变身菜单，全部入口在一处。',
      en: 'The right-click menu is the image\'s transform menu, all in one place.',
    },
    steps: {
      zh: [
        '反推提示词：从图片反向提取描述文字，存进便签或提示词库',
        '放大增强：提高分辨率、修复清晰度',
        '扩图（outpaint）：把画面边界向外延展',
        '图生视频：让静态图动起来。产物都自动落布并连线回原图',
      ],
      en: [
        'Reverse prompt: extract the description text back out of the image',
        'Enhance / upscale: raise resolution and sharpness',
        'Outpaint: extend the picture beyond its borders',
        'Image-to-video: bring it to life. Outputs auto-place and link back',
      ],
    },
    diagram: {
      nodes: [
        { x: 34, y: 58, w: 76, h: 70, kind: 'image', label: '🖼' },
        { x: 176, y: 12, w: 62, h: 40, kind: 'out', label: '2×' },
        { x: 176, y: 66, w: 62, h: 40, kind: 'out', label: '↔' },
        { x: 176, y: 122, w: 62, h: 40, kind: 'video', label: '▶' },
      ],
      links: [
        { from: 0, to: 1, dash: true },
        { from: 0, to: 2, dash: true },
        { from: 0, to: 3, dash: true },
      ],
      gestures: [{ type: 'click', x: 116, y: 96, label: '☑' }],
    },
  },
  {
    id: 'scene-consistency',
    icon: 'fas fa-user-check',
    title: { zh: '角色 / 风格一致性', en: 'Character / Style Consistency' },
    tip: {
      zh: '让多张图是同一个角色、同一种画风。',
      en: 'Keep many images on the same character, the same style.',
    },
    steps: {
      zh: [
        '挑一张最满意的角色图，右键 → 设为角色资产',
        '或挑一张定调的图，右键 → 设为风格资产',
        '之后生成新图时引用该资产，新图继承角色长相 / 画风',
        '配一张参考条：资产图与 App 节点连线即可反复使用',
      ],
      en: [
        'Pick your best character image, right-click → Set as Character Asset',
        'Or set a tone-defining image as a Style Asset',
        'New generations referencing the asset inherit the face / style',
        'Keep the asset linked to your App nodes to reuse it everywhere',
      ],
    },
    diagram: {
      nodes: [
        { x: 24, y: 62, w: 60, h: 60, kind: 'image', label: '👤' },
        { x: 148, y: 16, w: 64, h: 60, kind: 'app', label: 'App A' },
        { x: 148, y: 104, w: 64, h: 60, kind: 'app', label: 'App B' },
        { x: 250, y: 16, w: 52, h: 60, kind: 'out', label: '' },
        { x: 250, y: 104, w: 52, h: 60, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 1 },
        { from: 0, to: 2 },
        { from: 1, to: 3 },
        { from: 2, to: 4 },
      ],
      gestures: [],
    },
  },
  {
    id: 'scene-compose',
    icon: 'fas fa-object-union',
    title: { zh: '多图合成与网格排布', en: 'Compose & Grid Arrange' },
    tip: {
      zh: '多选之后，画布就是拼图台。',
      en: 'Select many, and the canvas becomes a collage table.',
    },
    steps: {
      zh: [
        '框选或 Shift+点选多张图片',
        '右键 → 多图合成：把选中图片拼合成一张新图（发工作台执行）',
        '右键 → 图片网格分组：自动整齐排成网格',
        '对齐 / 分布按钮（多选浮动栏）做最后微调',
      ],
      en: [
        'Box-select or Shift+click several images',
        'Right-click → Compose: merge the selection into one image via the workbench',
        'Right-click → Grid arrange: snap them into a neat grid',
        'Use align / distribute buttons on the selection bar for final polish',
      ],
    },
    diagram: {
      nodes: [
        { x: 30, y: 20, w: 54, h: 42, kind: 'image', label: '' },
        { x: 30, y: 96, w: 54, h: 42, kind: 'image', label: '' },
        { x: 104, y: 58, w: 54, h: 42, kind: 'image', label: '' },
        { x: 208, y: 40, w: 80, h: 76, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 3, dash: true },
        { from: 1, to: 3, dash: true },
        { from: 2, to: 3, dash: true },
      ],
      gestures: [{ type: 'drag', x1: 14, y1: 12, x2: 172, y2: 148, label: '⬚' }],
    },
  },
  {
    id: 'scene-chain',
    icon: 'fas fa-diagram-project',
    title: { zh: '串联流水线与重跑', en: 'Chaining & Rerun' },
    tip: {
      zh: 'A→B→C 连成流水线，改一步只重跑下游。',
      en: 'Chain A→B→C; change one step, rerun only downstream.',
    },
    steps: {
      zh: [
        '依次连线：图 → App A → App B → 成品，形成生成流水线',
        '连线方向 = 数据方向：左边是输入，右边是产物（自动溯源）',
        '改了中间某步的参数后，右键它 → 从此重跑，只重算它和下游',
        '选中多个 App 节点点 ▶，批量排队运行',
      ],
      en: [
        'Link step by step: image → App A → App B → final, a generation pipeline',
        'Link direction = data direction: inputs on the left, outputs on the right',
        'After tweaking a middle step, right-click → Rerun from here: only it + downstream',
        'Select several App nodes and hit ▶ to batch-queue them',
      ],
    },
    diagram: {
      nodes: [
        { x: 16, y: 70, w: 54, h: 54, kind: 'image', label: '🖼' },
        { x: 106, y: 70, w: 60, h: 54, kind: 'app', label: 'A' },
        { x: 198, y: 70, w: 60, h: 54, kind: 'app', label: 'B' },
        { x: 262, y: 24, w: 46, h: 48, kind: 'out', label: '' },
        { x: 262, y: 116, w: 46, h: 48, kind: 'out', label: '' },
      ],
      links: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 2, to: 4 },
      ],
      gestures: [{ type: 'click', x: 196, y: 132, label: '⟳' }],
    },
  },
]

/** 取指南页（当前语言；缺失回退 zh）。渲染无关的纯数据。 */
export function guidePages(lang = 'zh') {
  const pick = (v) => (v && typeof v === 'object' ? v[lang] ?? v.zh ?? '' : String(v ?? ''))
  return PAGES.map((p) => ({
    id: p.id,
    icon: p.icon,
    title: pick(p.title),
    tip: pick(p.tip),
    steps: p.steps[lang] || p.steps.zh,
    diagram: p.diagram,
  }))
}

/** 分组（导航渲染用）：A 节点类型 / B 场景玩法 */
export function guideGroups(lang = 'zh') {
  const names =
    lang === 'en'
      ? { nodes: 'Node Types', scenes: 'Scenarios' }
      : { nodes: '节点类型', scenes: '场景玩法' }
  const pages = guidePages(lang)
  return [
    { key: 'nodes', label: names.nodes, pages: pages.slice(0, 6) },
    { key: 'scenes', label: names.scenes, pages: pages.slice(6) },
  ]
}
