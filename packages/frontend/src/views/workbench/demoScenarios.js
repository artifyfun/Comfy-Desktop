// 场景速览：开箱即用的示例场景（封面 + 示例提示词 + 一键开始）
// 素材来源：Unsplash / Pexels（免费许可，可商用），已打包到 public/demo/
export const SCENARIOS = [
  {
    id: 't2i',
    presetId: 'text-to-image',
    image: '/demo/t2i.jpg',
    title: { zh: '文生图 · 樱花护城河', en: 'Text→Image · Sakura Moat' },
    desc: {
      zh: '黄昏光线 + 城市天际线 + 樱花前景，一句话出氛围大片',
      en: 'Golden-hour skyline with sakura foreground — atmosphere from one line',
    },
    prompt: {
      zh: '黄昏时分的城市护城河，两岸樱花盛放，落日余晖把天空染成粉紫色，远处都市天际线，河面小船点点，电影感构图，柔和光线，超精细细节',
      en: 'A city moat at dusk, cherry blossoms in full bloom on both banks, sunset tinting the sky pink-purple, distant skyline, small boats on the water, cinematic composition, soft light, ultra-detailed',
    },
  },
  {
    id: 'i2i',
    presetId: 'image-to-image',
    image: '/demo/i2i.jpg',
    seedImage: '/demo/i2i.jpg',
    title: { zh: '图生图 · 人像风格化', en: 'Image→Image · Portrait Restyle' },
    desc: {
      zh: '自动附带示例参考图，一键体验「保持构图换风格」',
      en: 'Ships with a sample reference — restyle while keeping composition',
    },
    prompt: {
      zh: '把这张人像转绘为赛博朋克风格：霓虹紫蓝双色打光，金属质感外套，背景霓虹城市夜景，保持人物姿态与构图不变',
      en: 'Restyle this portrait into cyberpunk: neon purple-blue rim light, metallic jacket, neon city nightscape background; keep the pose and composition unchanged',
    },
  },
  {
    id: 'video',
    presetId: 'video-gen',
    image: '/demo/video.jpg',
    video: '/demo/video-demo.mp4',
    title: { zh: '视频生成 · 云海日出', en: 'Video · Sea of Clouds Sunrise' },
    desc: {
      zh: '延时质感 + 缓慢推进的镜头语言，视频生成的标准打开方式',
      en: 'Timelapse texture with a slow push-in — the canonical video prompt',
    },
    prompt: {
      zh: '延时摄影：雪山之巅云海翻涌，日出金光逐渐染红山峰，镜头缓慢向前推进，电影质感，大气磅礴',
      en: 'Timelapse: a sea of clouds rolling beneath snow peaks at sunrise, golden light creeping over the ridges, slow camera push-in, cinematic and majestic',
    },
  },
  {
    id: 'omni',
    presetId: 'omni',
    image: '/demo/style.jpg',
    title: { zh: '全能 · 古典油画静物', en: 'Omni · Classical Still Life' },
    desc: {
      zh: '不锁意图的模式怎么用：巴洛克质感 + 明暗对照法，直出博物馆级静物',
      en: 'How to use the unlocked mode: baroque still life with chiaroscuro lighting',
    },
    prompt: {
      zh: '荷兰古典静物油画风格：深色背景前的瓶插花束，郁金香与牡丹盛放，明暗对照法光线，巴洛克质感，博物馆级细节',
      en: 'Dutch Golden Age still life: a vase of tulips and peonies against a dark background, chiaroscuro lighting, baroque texture, museum-grade detail',
    },
  },
]

export function scenarioByPreset(presetId) {
  return SCENARIOS.find((s) => s.presetId === presetId)
}
