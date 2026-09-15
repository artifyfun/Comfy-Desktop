# 提示词最佳实践与参考仓库（2026-09 调研）

面向画布「提示词库」（`packages/frontend/src/views/canvas/promptLibrary.js`）的重写，
把五类工作流（文生图 / 文生视频 / 图生视频 / 图生图 / 图像编辑）的实践固化成可点词条。
本文记录**来源与提炼**，词库只放可直接插入提示词的片段与模板。

> 原则：只收录"能落到提示词文本上"的经验。厂商规范少、社区实测多——凡是社区经验，
> 本文都标明出处；标「技能」的来自本仓内置技能，是已经过本项目验证的口径。

## 一、参考仓库（可直接拿来对照的）

| 仓库 | 规模 / 特点 | 值得抄什么 |
|---|---|---|
| `cclank/lanshu-awesome-ai-video-kit` | 543 条 prompt · 15 模型 · 21 篇方法论 · 7 个 Claude Skill；GitHub Action **每周巡检 32 个官方端点**，模型更新自动开 issue | 视频「**进阶 8 要素**」骨架（主体/动作/场景/运镜/光影/风格/约束/节奏）、运镜词典、约束词清单、各家官方公式（Seedance 8 要素 / Veo 8 元素 / Kling 5 层 / Sora Shot List）。**对抗版本漂移**的做法本身就值得学 |
| `ZeroLu/awesome-seedance` | ⭐2.4k · 六语言 · 每条带来源出处 + 真实生成视频 | 按「效果 → 反查写法」，用于校准运动与运镜描述 |
| `YouMind-OpenLab/awesome-seedance-2-prompts` | 2000+ 条 · 网页画廊 | **带时间轴的分镜脚本**（0-4s / 4-9s / 9-15s 各写什么），多镜头叙事参考 |
| `PicoTrex/Awesome-Nano-Banana-images` | 110 条编辑类案例（Gemini 2.5 Flash Image 系） | 图像编辑的「保留 / 改动」写法与失败模式 |
| `ZHO-ZHO-ZHO/ZHO-nano-banana-Creation`、`songguoxs/gpt4o-image-prompts` | 中文社区合集（含 Seedance 部分） | 中文提示词的分号断句、模块化组织 |
| `EvoLinkAI/awesome-gpt-image-2-prompts` | ~50 案例 + JSON 索引 | 摄影器材当风格锚点、否定词集中在末尾、引号内文字按字面渲染、版面结构化输出（设定卡/UI 稿） |
| `promptslab/Awesome-Prompt-Engineering` | 通用提示工程论文/工具索引 | 只在大方向上有用（多模态提示技术综述），与绘画/视频提示词关系有限 |

另有两个常被引用的站点型合集：`opennana.com/awesome-prompt-gallery`、`aipromptnav.com`（浏览向，不复用其文本）。

## 二、模型分档（**最重要的一条**：写错档位等于白写）

| 模型族 | 提示词风格 | 质量词 | 负面词 |
|---|---|---|---|
| **Flux 全系**（klein/pro/max/flex/dev） | 自然语言散文，禁止标签堆砌 | ❌ 无意义 | ❌ **没有负面**（negative 留空；cfg 必须 1.0） |
| **Krea2**（Turbo / Raw） | 3–6 个具体短语堆叠；Raw 可走结构化 JSON | ❌ Turbo 无用 | ⚠️ 仅安全兜底 / 压拼贴 |
| **Qwen-Image / Qwen-Image-Edit** | 指令式自然语言 | ❌（cfg=1 蒸馏） | ❌ 用「保留项」替代 |
| **SD1.5 / SDXL** | 标签式 | ✅ 有效 | ✅ 必需（SD1.5 尤其） |
| **SD3 / 3.5** | 标签+自然语言 | 有限 | 极简（`low quality, blurry` 足够） |
| **Anima** | Danbooru 标签 + 2–4 句自然语言 | ✅ 有效 | ✅ 有效（base cfg>1 时） |
| **WAN 2.2**（T2V/I2V/FLF） | 自然语言，必须写运动与时间推进 | — | ✅ **REQUIRED**（官方整串，含 `motionless image`） |
| **LTX-2 / H3** | 自然语言；H3 走结构化多模态段 | — | ❌ 蒸馏 cfg=1，别调 CFG |

Flux 系的"负面替代"走正向描述（来自 `flux-image-best-practices` 技能）：
`no makeup → natural skin texture, bare face` / `no blur → sharp focus, tack-sharp` /
`no people → empty, deserted` / `no text → clean surfaces, unmarked`。

## 三、按模态的写法要点

### 文生图
- 自然语言公式：`主体 + 动作 + 媒介/风格 + 环境 + 光照 + 镜头/技术`；**词序即权重**，30–80 词最佳。
- 标签式顺序：质量 → 主体 → 细节 → 动作 → 环境 → 构图 → 光照 → 风格；**权重有效域 0–2**（>1.5 出伪影），超 77 token 必须 `BREAK`。
- 三条铁律：**光照必须显式写**；用**器材/胶片规格**当风格锚点（`35mm color film photography, harsh direct on-camera flash`）比 "realistic photo" 稳；镜头参数是真指令（`85mm f/1.8`）。
- 别写空话堆栈：`masterpiece, best quality, 8k, trending on artstation` 对现代自然语言模型无效。

### 文生视频
- 骨架用 8 要素；**只写静态画面会输出静止视频**——必须有运动动词 + 环境动态（花瓣/风/光）。
- 运镜写法：**运动类型 + 幅度（small/large）+ 速度（slow/fast）**，写进句内，如
  `the camera pushes in with small amplitude at slow speed toward …`。
- 切镜：`[Shot 2] At 00:03.500, the camera cuts to …`，首镜不加时间戳，切点严格递增；
  **只改距离/小角度时优先用运镜**而不是切镜。切镜必须引入新信息。
- 帧率口径别混：WAN 16fps / 帧数 `4n+1`；H3 24fps / `17k+5` 且单镜 ≤15s；LTX 25fps / `8n+1`。

### 图生视频 / 首尾帧
- 写**帧间路径**而不是两张静态图：I2V 四段 `first-frame anchor → action onset → continuous development → result or reaction`。
- 变形语言：用 `smoothly transforms` / `seamlessly morphs` / `gradually reshapes`；
  **禁用** `magical / enchanted / mystical`（会生成字面闪光粒子）。
- 运动幅度是主旋钮：LTX `strength≈0.6`（设 1.0 会冻结）、WAN `shift` 越低运动越强、Pusa `noise_multipliers` 趋 0 更贴源。
- 一致性要显式写（`keep the subject appearance … consistent throughout the shot`），并在负面里补 `motionless image`。

### 图生图
- 提示词写**变化方向**（`convert A into B, keep X`），构图交给源图。
- denoise 0.4–0.7 保留构图微调，0.7–0.9 大幅重绘。

### 图像编辑（本次重点补的一类）
- **先锁不变项，再写唯一改动**。不写保留项，模型会把整张图重建（脸/光/背景全漂）。
  `Keep the same person, facial features, hairstyle, clothing, pose and camera framing. Replace only the background with …`
- 三段式：`Preserve exactly: … Edit only: … 输出约束`。
- **五个高遵循动作词**：`Add / Change / Make / Remove / Replace`（用它开头写指令）。
- 一次只改一处；多改会把变量混在一起，出问题无法归因。
- 多轮编辑（Qwen-Edit 类）：**每轮重新锚定服装与不变项**，否则逐轮漂移；编辑链控制在 4–5 层以内。
- 特写/拥抱类必加比例约束（`head and body should be proportional … do not enlarge her head`）。
- 换装/角色替换（Krea2 identity-edit）：PRIMARY=人物、SECONDARY=服装，**顺序不可互换**。
- 局部重绘：prompt 只写**要变成什么**，不要描述原图。

## 四、落到词库的映射

`promptLibrary.js` 的 15 个分类即按此组织：① 模型分档 → ②–④ 文生图（骨架/自然语言/标签式）
→ ⑤ 文生视频 → ⑥ 图生视频 → ⑦ 图生图 → ⑧ 图像编辑 → ⑨ 完整模板 → ⑩–⑮ 通用词库。

面板的交互约束决定了数据形状：**可点片段（`text`）必须是能直接插进提示词的内容**，
所以写法规则、适用模型、参数联动都放在 `hint`（面板 tooltip 与搜索结果都读它）。

验收：`scripts/wb-promptlib-ui-verify.mjs`（W12）——分类/条目/ hint 完整性、搜索命中、
点词条回填便签；单测 `promptLibrary.test.js` 锁五模态覆盖与关键条目在场。
