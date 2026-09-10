# AI 创作工作台 / 无限画布：Agent 编排与画布架构对标调研

> 状态：研究分析（未改代码）｜对象：artify-desktop（ComfyUI Desktop fork + AI 工作台）
> 调研方法：官方站点 / 官方帮助文档 / 官方博客优先，其次 36kr / 量子位 / 虎嗅 / 硅星人等媒体报道与社区实测。
> 每个关键论断标注来源 URL，并区分【官方确认】与【社区/二手】。
> 委托方现状参照：`docs/workbench-harness-architecture.md`（PLAN JSON 单轮决策）、`docs/external-agent-architecture.md`（ACP/Claude 通道）、`docs/workbench-plan-v2.md`。

---

## 0. TL;DR

1. **行业已收敛到「无限画布 + 内嵌 Agent」范式**：画布从"手动连线"（ComfyUI/Krea Nodes/Magnific Spaces 节点派）与"图层 moodboard"（即梦/Firefly Boards/Lovart 派）两条路，同时长出一个内嵌对话 Agent——Agent 不是侧边聊天窗，而是**直接在画布上创建/修改对象**。
2. **最激进的对标是 RunningHub RHTV**：同为 ComfyUI 生态，它已做到「Agent 在画布上自动批量生成节点、搭建整套工作流、每步可暂停干预」——这正是委托方 canvas_ops 工具想走但还没走通的路（[量子位 2026-05](https://www.qbitai.com/2026/05/413912.html)）。
3. **一致性不再靠手动调参**：头部产品把「角色/风格资产」做成一等公民（RHTV 角色资产设定表、Seedream 4.0 多图参考/多图输出、可灵多主体参考、Firefly 参考图+Style Kits），Agent 自动维护前后画面统一。
4. **委托方最大的 3 个差距**：① 单轮 PLAN JSON 无执行结果回流、无多步自主循环（模型"看不到"生成结果，靠前端 autoRecover 补锅）；② AI 与画布只有侧信道——canvas_ops 工具有了但不是产品主路径，用户看不到 AI"在画布上干活"的过程；③ 无角色/风格资产层与画布版本管理，一致性全靠用户手动喂参考图。
5. **好消息**：委托方已有的 AG-UI 流式、wb_* MCP 工具面、ACP/Claude 外部通道、本地 ComfyUI 引擎，恰好是补齐这些差距的全部基建；按本文建议清单（第 5 节）约 30–55 人天可完成第一梯队收敛。

---

## 1. 调研口径说明

- 【官方】= 产品官网 / 官方帮助文档 / 官方博客 / 官方发布会通稿原文可查证。
- 【二手】= 媒体评测、社区帖、第三方博客；用于补官方未公开的实现细节，可信度次一级。
- 部分站点（Canva newsroom、Genspark helpcenter、Magnific Spaces、Krea docs、Flowith）对自动抓取返回 403/失败，其结论基于可抓取的页面标题、导航结构、搜索摘要与多篇交叉印证的媒体报道，已逐条标注。
- 「实时性」「版本管理」等无公开文档的维度，标注为"无公开证据"而非臆断。

---

## 2. 逐产品分析（中国）

### 2.1 即梦 AI（ByteDance / Dreamina）

**产品形态**：一站式 AI 创作平台（文生图 / 视频生成 / 智能画布 / 数字人），网页+App。【官方】[jimeng.jianying.com](https://jimeng.jianying.com/) 导航即「文生图｜视频生成｜智能画布｜探索」。

**画布架构：图层/资产 moodboard 式，非节点图**
- 智能画布入口 `jimeng.jianying.com/ai-tool/assets-canvas`（[二手实测引用](https://www.woshipm.com/ai/6292231.html)）。布局为：左侧资产/编辑面板 + 中央自由画布 + **右侧对话 Agent**。
- 画布上是**图片对象**（可拖拽、缩放、并排比较、选中后出现工具条：扩图/擦除/去背景/高清放大/局部重绘），不是节点、没有连线。【官方帮助】画布操作教程可见「上传→展开 Expand→修复 Inpaint→润饰 Retouch→放大 Upscale→导出」的工具箱式流程（[官方帮助：AI 扩图](https://jimeng.jianying.com/features/resource/ai-expand-image)）。

**AI 在画布上能做什么**
- 对话框本身是 Agent：输入结构化提示词可**一次批量生成整套图**（品牌 VI 全套、8 格分镜、绘本 8 页），生成结果直接铺到画布。
- 选中画布上的图 →「添加到对话」→ 用自然语言继续修改（"去掉树叶""把文案换成 XX"）；Agent 输出的图也可**拖回画布**。画布与对话双向拖拽。【二手实测】[woshipm 2025-11](https://www.woshipm.com/ai/6292231.html)。
- 画布还支持多图→智能多帧视频、AI 配乐、补帧、提分辨率等后处理链。【二手实测】同上。

**chat→canvas Agent 链路**：有，且是产品主路径。但它是「对话式生成/修改 + 画布陈列」，**没有可见的 plan 步骤树**，Agent 内部怎么调工具对用户黑盒；干预方式是"再说一句"而不是"暂停/改某一步"。

**Seedream 4.0 多图一致性如何呈现**：【官方】[Seed 官方发布](https://seed.bytedance.com/zh/blog/%E4%B8%8D%E6%AD%A2%E4%BC%9A-%E7%94%BB-%E6%9B%B4%E4%BC%9A-%E6%83%B3-seedream-4-0-%E5%9B%BE%E5%83%8F%E5%88%9B%E4%BD%9C%E6%A8%A1%E5%9E%8B%E6%AD%A3%E5%BC%8F%E5%8F%91%E5%B8%83)（2025-09-09）
- 单一架构统一生成与编辑；**多图参考最多十余张**，同时抽取人物特征/场景风格/物体结构融合（虚拟试衣、零件组合）。
- **多图输出**：一次生成角色连贯、风格统一的图像序列（分镜、漫画、成套 IP 设计）——一致性在**模型层**解决，产品层只管陈列。
- 精准编辑（一句话修图）、视觉信号可控生成（草图/涂鸦/辅助线原生引导，无需 ControlNet）、自适应比例与 4K。
- 在即梦产品里的呈现：用户上传参考图 + 一句话，模型直接保持人物/风格一致，**用户不接触种子/权重/LoRA 概念**。

**对比维度小结**：图层 moodboard 画布｜chat→生成/直改对象（Agent 黑盒）｜工具=模型能力内嵌｜一致性=模型层多图参考｜无 realtime paint｜资产历史有、画布快照/分支无公开证据。

**可推断的实现信号（闭源推断，标注置信度）**：
- 即梦无限画布的 URL 结构 `/ai-tool/assets-canvas` 表明画布被实现为「资产容器」视图（assets-canvas），与独立的图片生成页并列——推断画布状态在服务端按会话/项目持久化，用户换设备可恢复（高置信，来自产品结构）。【二手推断】
- 右侧对话框可解析「官方结构化提示词模板」并按用户主题改写（VI 场景实测：AI 参考官方提示词格式生成新结构化提示词）——推断对话 Agent 内置了「提示词结构化改写」这一工具步骤（高置信，实测复现）。【二手实测】
- 「生图不扣费、修改编辑扣积分」的计费拆分（实测引用）说明生成与编辑走不同的模型推理管线，编辑（Seedream/SeedEdit 指令式编辑）按次计费——产品把「改图」视为更高价值操作。【二手实测】
- 无公开证据表明画布有节点式执行图或 DAG；Seedream 4.0 的「一次生成 N 张一致图」说明批量一致性由模型单次推理完成，而非前端多次调用拼接（中高置信，官方博客「多图输出=全局规划与上下文一致性」表述）。【官方确认】

---

### 2.2 MiniMax（MiniMax Agent / MiniMax Code / Hailuo）

**产品形态**：通用 Agent（云端虚拟机工作区）+ 桌面端 MiniMax Code（本地工作区）+ Hailuo 视频生成。【官方】[agent.minimax.io](https://agent.minimax.io/) / [agent.minimaxi.com](https://agent.minimaxi.com/)。

**工作台形态：Manus 式 VM + 文件树，桌面端补了「无限画布」**
- 工作区 = 本地项目目录：Agent 在目录内读文件、执行命令、产出物汇报；`@` 引用文件；文件/变更/终端三面板审查结果。【官方】[工作区与项目上下文](https://agent.minimaxi.com/docs/code/workflows/workspace)。
- **桌面端无限画布**（【官方】[infinite-canvas 文档](https://agent.minimaxi.com/docs/code/desktop/infinite-canvas)）：把图片、视频、HTML 页面等文件铺在一张自由画布上，与 Agent 对话并行；核心交互是——
  - 画布对象多选 → **添加到对话**作为上下文继续创作；
  - **标注修改**：图片框选区域、HTML 选中具体元素加评论，连同文件一起发回 Agent；
  - **多版本并排比较**，选喜欢的继续打磨；
  - HTML 节点「探索方案」：选风格/配色/布局/动画方向，一次生成多个方案。
- 这是「**成果陈列 + 标注回传**」型画布：画布上不是可生成节点，而是产物文件；AI 不在画布上直接画，而是对话后把产物放回画布。

**工具面**：代码执行、搜索、Hailuo 图像/视频生成、MCP 服务、插件市场、Agent Team 多智能体。【官方】[Agent 能力目录](https://agent.minimaxi.com/docs/code/welcome)。

**多模态产物如何进工作区**：Agent 生成图片/视频后作为文件落工作区，用户拖入画布比较；视频侧有独立的 Hailuo Video Agent——【官方】[发布公告](https://www.minimax.io/news/video-agent)（2025-06）明确三阶段路线：预置模板一键成片 → 半可定制 → 全自动端到端；核心设计是 **"LLM 工具调用取代传统节点式工作流"** + "推理过程与工作流可视化"。这条路线图等于官方承认：视频创作从节点工作流走向 agent 编排。

**对比维度小结**：虚拟机/本地文件树工作区 + 陈列型画布｜chat→plan→工具执行（透明化推理）｜工具=代码执行/搜索/生成/浏览器｜一致性无专门机制｜无实时 paint｜任务历史有。

**可推断的实现信号**：
- 桌面端「无限画布」文档明示画布节点类型是**文件引用**（图片/视频/HTML/其他文件），且 HTML 节点可选中具体元素加评论——推断前端有 DOM 级元素定位能力（类似 Figma dev mode 的元素选择器），标注以「文件+区域坐标+评论文本」结构随对话回传（高置信，官方文档直接描述）。【官方确认】
- Hailuo Video Agent 三阶段路线图（模板→半定制→全自动）是产品化的 plan 深度控制旋钮：Stage1 隐藏 plan、Stage2 暴露分段编辑、Stage3 全自动——推断内部同一套 agent 编排，仅 UI 暴露程度不同（中置信，官方路线图表述）。【官方确认】
- 「可视化 agent 推理与工作流」官方原文说明其前端已实现步骤流渲染，与 AG-UI 的 StepStarted/Finished + 工具卡形态同构。【官方确认】

---

### 2.3 可灵 AI（快手 Kling）

**产品形态**：AI 视频与图像生成平台（网页创作台 + App）。【官方】[kling.ai/cn](https://kling.ai/cn/)、创作台 [klingai.com/app](https://klingai.com/app)（"Next-Generation AI Creative Studio"）。

**画布架构**：**无节点画布**。创作台以「表单式参数面板 + 生成结果流 + 素材库」为主；视频编辑按时间线组织。帮助文档体系在 [klingai.com/docs](https://www.klingai.com/docs)。【官方】

**AI 驱动方式**：表单+提示词为主，无 chat→canvas 的 agent 链路公开证据；平台能力重点押在**模型层一致性**：
- 多主体参考 / 多图参考：上传多张角色图保持人脸、服装一致性；视频侧支持首尾帧、角色参考。【官方】[AI Video Character Consistency 指南](https://kling.ai/quickstart/ai-video-character-consistency)（页面标题与文档结构可查，正文需登录）。
- 元素库：把角色/物体存为可复用元素，跨视频调用（【二手】[Atlas Cloud Kling 3.0 一致性指南](https://www.atlascloud.ai/zh/blog/tips/how-to-use-kling-3-0-for-character-consistency)）。
- 【二手】[量子位智库 AI 100](https://hub.baai.ac.cn/view/49620) 指出：多模态输入（多图参考）已成视频平台标配，各家角逐一站式生成能力。

**对比维度小结**：无画布（表单+时间线）｜无 agent 链路｜工具=生成模型族｜一致性=元素库+多主体参考（模型层）｜无实时性｜版本=生成历史。

**实现信号**：官方 API 能力图（[视频能力目录](https://www.klingai.com/document-api/guides/capability-map/video)）把多图参考/首尾帧/角色一致性列为 API 级参数——说明一致性在快手体系内是**模型接口的一等参数**而非前端技巧；委托方模板参数面若把"参考图组+角色 ID"提升为 wb_execute_template 的一级参数，即可对齐这一层（对接建议 #4）。【官方确认】

### 2.4 通义万相 / 阿里（万相企业版 + 百炼）

**产品形态**：万相企业版（电商向生图工作台）+ 百炼 Model Studio（模型 API + 智能体应用）。【官方】

**画布架构**：**无画布**。万相企业版是"场景卡片 + 表单参数 + 生成预览 + 资产库"结构：【官方】[万相基础功能文档](https://help.aliyun.com/zh/model-studio/wanxpro-basic-function) 列出基础创作 / 背景图生成（预设场景或自定义描述、风格参考图、元素引导）/ 虚拟模特（主模+场景，自动分割区域）三大场景，全部是表单式。

**Agent 编排**：不在万相侧，在百炼侧——智能体应用（单 agent 编排、插件、知识库、工作流）是开发者向能力，与创作画布无关。【官方】[百炼智能体应用](https://help.aliyun.com/zh/model-studio/single-agent-application)。

**对比维度小结**：纯表单工作台｜无 AI 驱动画布｜工具=生成 API｜一致性=参考图/同款生成（表单内）｜无实时性｜资产页保存生成记录。

**实现信号**：万相的「背景图生成/虚拟模特」把电商工作流（商品图→场景合成→模特上身）固化成了三个表单场景，底层是自研 Composer 组合生成框架——**"场景模板化"是阿里对 agent 问题的回答：与其让用户描述，不如把高频任务做成场景卡**。委托方模板库+PLAN intent 路由是同一思路的低配版，可借鉴其"场景卡=固定输入槽+预设参数+参考图槽"的表单化收口（降低 Agent 出错面）。【官方确认】

---

### 2.5 LibLibAI 哩布哩布（ComfyUI 系）+ 星流 Agent

**产品形态**：国内最大 AI 模型/工作流社区之一：在线 ComfyUI 工作流运行、在线生图（AI 界面）、模型社区、训练。【官方】[liblib.art](https://www.liblib.art/)。

**画布架构（平台侧）**：在线 ComfyUI = **完整节点画布**，用户手动连线，平台托管 GPU 跑图（教学页可见工作流在线运行流程：【官方教学】[扩图工作流使用方法](https://www.liblib.art/teaching/388fcb1b3f5b42838bc20af2cfdf9351)、[高清放大工作流](https://www.liblib.art/teaching/7d94074fa3684dba9e713dc66855abc9)）。

**有没有做「AI 帮你排 workflow / 对话式生图」**：做了，但放在独立产品**星流 Agent**里，而不是改造在线 ComfyUI：
- 星流 = Lovart 国内版（【二手报道】[开源中国](https://www.oschina.net/news/358708)、[投资界](https://news.pedaily.cn/20250703/110094.shtml)）。官网自称"新一代设计 Agent"。【官方】[xingliu.art](https://www.xingliu.art/)
- **注意：星流已于官网挂出 2026-10-10 24:00 停止服务、迁移 Lovart.art 的公告**（【官方】[xingliu.art 首页横幅](https://www.xingliu.art/)）——"国内合规版+海外版"双轨收缩为海外单轨，对国内对标格局是个信号。

**星流的 Agent 编排方式**（【二手深度评测】[虎嗅/硅星人 2025-07](https://www.huxiu.com/article/4543329.html)）：
- 四区布局：左上工具栏（模式/插入/生图模型选择/尺寸）、中央画布、右侧 AI 对话框。
- 流程：**先理解需求 → 给 4 个优化方向供选 → 选定后"工程化"成设计说明（比例/构图/配色/文字排版）→ 挑选工具（kontext 等模型）生图**——即 chat→plan(方案选择)→工具执行，且 plan 显式呈现给用户。
- **把每张图的处理过程打包成工作流，方便追溯修改历史**（画布上能看到这张图是怎么一步步来的）。
- 画布快捷编辑：选中图片按 Tab 进入"用嘴 P 图"；高清放大/扩图/去背景/擦除工具条。
- 图生视频会自主规划（先生成结束帧，再调视频模型），生成后**自检是否满足需求，不满足自动再生成**——agent 自我修正闭环。
- 短板（同评测）：中文文字修改不稳、点数贵、复杂任务出错率不低。

**对比维度小结**：节点画布（在线 ComfyUI）与 Agent 画布（星流）**双产品并行**｜星流=chat→方案树→工具执行｜工具=社区模型+工作流封装｜一致性=参考图+社区 LoRA｜无实时性｜**处理链打包成工作流可追溯**（版本管理亮点）。

**星流停服的信号**（本报告判断）：LibLib 选择把 Agent 能力收敛到 Lovart 海外版而非双线维护——推断原因：算力成本（agent 多步调用烧积分，国内定价 49 元/4000 点被虎嗅评为"不便宜"）+ 国内合规（模型/内容审查多步链路成本高）。对委托方的反向启示：**本地化部署（用户自己的 GPU）恰是云平台 agent 烧钱痛点的解法**——委托方"本地 ComfyUI 引擎 + agent 编排"在成本结构上优于 RHTV/星流的云端代跑，这个差异化应写进产品叙事。【分析判断】

---

### 2.6 Tensor.Art

**产品形态**：在线 AI 图像生成 + 模型托管社区（在线训练/在线跑图）。【官方】[tensor.art](https://tensor.art/)。

**画布架构**：提供**在线节点工作流**（与 ComfyUI 同范式的自研节点编辑器），社区分享工作流一键运行（示例：【官方页面】[新手入门工作流-图生图](https://tensor.art/workflows/817655451259990898)）；另有表单式在线生图（CI/模型页）。【二手介绍】[AIbase](https://top.aibase.com/tool/tensor-art)。

**AI 排 workflow**：**无公开证据**表明有 AI 自动编排/对话式生图工作流；其迭代重心在模型托管、在线训练与积分体系。

**对比维度小结**：节点画布（手动）+ 表单生图｜无 agent｜工具=托管模型/训练｜一致性=LoRA/模型选择（手动）｜无实时性｜工作流可收藏复用。

**定位对照**：Tensor.Art 与 LibLib 同属"ComfyUI 系平台但未做画布 agent"的阵营（截至本报告无公开证据），说明**"在线托管节点画布"本身已不足以构成壁垒，壁垒在谁先把 agent 编排做进画布**——RHTV 与 LibLib/星流的分化即是证据。委托方作为桌面端 fork，引擎侧比 Tensor.Art 更开放（可装任意节点包），agent 侧补齐 #1/#2 后在这一阵营中即处领先位。

---

### 2.7 RunningHub（ComfyUI 系）—— 与委托方最直接对标

**产品形态**：ComfyUI 工作流云平台 → 已扩展为「原生 AI 智能体驱动的内容创作平台」。【官方】[runninghub.cn](https://www.runninghub.cn/) 导航：**无限画布** / RHSTORY(Beta) / 快捷创作 / VibeX / AI 应用 / ComfyUI 工作流 / API / 模型。

**画布架构：两代并存**
- 经典：ComfyUI 工作流在线运行（节点画布托管 GPU）。
- 新：**无限画布 + RHTV**（rhtv.ai），2026 年推的画布原生智能体平台。

**Agent 编排方式（重点）**——【二手深度实测】[量子位 2026-05-07《原生 Agent 杀入画布》](https://www.qbitai.com/2026/05/413912.html)：
- 画布内有**三种生成模式**：常规图片生成（手动建节点）、视频生成（手动建节点）、**Agent 模式**（自动规划完整工作流、对话式创作）。
- Agent 模式的完整链路（实测）：用户一句话 → Agent **拆解任务、给出 2–3 个创意方向供拍板** → 拟剧情大纲 + 制作参数清单（时长/比例/画风，按需勾选）→ 生成**角色资产设定表**统一人物视觉特征 → 自动拆分分镜 → **在画布内自动批量生成节点、搭建整套工作流** → 分段生成视频（自带 BGM）→ 每段支持超清修复/帧提取/内容解析 → 内置剪辑器拼接成片。
- **全程可视化、可暂停、可干预、可局部修改**，不用整体推翻重跑（"不抽盲盒式创作"）。
- **画布原生内置**智能体，不需要跳转或挂外挂工具——官方卖点。
- 商用侧：上传商品图 → Agent 引导补需求 → 规划每张主图卖点逻辑 → 搭批量出图工作流一次出 8 张 → **编辑元素=分层抠图**。
- 还内置影视级工具（摄影机控制、分镜大师、宫格裁剪、打光、3D/2D 导演台）与公共素材库。
- **长期记忆**：记住创作偏好与艺术风格；满意的项目**一键打包保存为工作流**，换素材整组重跑。
- 生态底座（官方口径，转引自量子位）：170+ 标准模型 API、10 万+ 社区 AI 应用 API、13681 个可用节点、图像/视频/音频/3D/文本五模态。
- 无限画布本身另有上线报道：【二手】[凤凰网《RunningHub 上线"无限画布"》](https://baby.ifeng.com/c/8r5RzNXHzpo)。

**对比维度小结**：节点画布 + 画布原生 Agent｜**agent 自主多步 + 每步汇报拍板 + 自动建节点**｜工具=全域模型/工作流/剪辑/分镜工具｜一致性=角色资产设定表｜进行中可视化（非实时 paint）｜工作流打包=版本资产。**这是委托方的镜像竞品：同样的 ComfyUI 生态底座，但完成了"Agent 在画布上自动搭工作流"的产品化。**

**可推断的实现信号**：
- 「画布原生内置智能体」+「Agent 模式/手动模式并存」——推断其架构是：Agent 进程产出结构化操作指令（建节点/连线/设参），复用与手动模式**同一套画布数据模型**落盘；因此 AI 建的节点与手动建的节点完全同构、可继续手动改（高置信，量子位实测截图显示 Agent 建立的节点与经典 ComfyUI 节点同形态）。【二手实测】
- 「每步可暂停、干预、局部修改，不用整体推翻重跑」——推断其 agent 编排是**步进式确认**（step-gate）：每个阶段（方向→大纲→参数→资产→分镜→生成）之间有显式等待用户的状态，而非一跑到底（高置信，实测流程分六步确认）。【二手实测】
- 「角色资产设定表」作为独立产物出现——推断其工具面有「资产登记」类工具，把角色描述+参考图注册为后续所有生成调用可引用的对象 ID（中高置信）。【二手实测】
- 「满意的项目一键打包保存工作流，换素材整组执行」——推断打包产物是参数化的 ComfyUI workflow 模板：把用户素材抽为输入参数，其余固化为图结构（高置信，与 RunningHub 既有工作流商业化能力同源）。【二手实测】

---

### 2.8 扣子 / Coze（字节）

**产品形态**：AI Agent 开发平台（低代码）+ 扣子空间（对终端用户的 AI 办公空间）。【官方】[coze.cn](https://www.coze.cn/)、[扣子空间](https://www.coze.cn/space-preview)、国际版 [coze.com](https://www.coze.com/)；核心已开源【官方】[coze-dev/coze-studio](https://github.com/coze-dev/coze-studio)。

**画布架构：两种画布，服务两类人**
- **工作流画布**（开发者向）：节点图编排（LLM 节点/插件节点/知识库节点/图像处理节点/画板节点……），试运行时**运行成功的节点边框显示绿色**、节点右上角查看输入输出；工作流有**版本管理、引用关系图（资源 A→B 箭头图）、跨画布复制节点、封装/解散子工作流、异步执行（超时延长到 24h）**。【官方】[使用低代码工作流](https://docs.coze.cn/guides_use_workflow)
- **多 Agent 模式画布**：把多个 Agent 作为节点连成图，每个 Agent 节点配置「适用场景描述 + 独立提示词 + 独立技能（工具/工作流/知识库）」，开始节点按语义路由把用户消息分发给合适 Agent；支持全局跳转条件、单节点直调调试。【官方】[多 Agent 模式](https://docs.coze.cn/guides_multiagent)
- **画板节点**：工作流里的图层式小画板（图片/文本/图形/画笔 + 变量元素引用上游输出 + 图层置顶置底），用于图文排版合成。【官方】[画板节点](https://docs.coze.cn/guides_canvas_node)

**「节点画布 vs agent 编排」的融合思路**（对委托方最有参考价值）：
- Coze 的答案不是二选一，而是**分层**：Agent 负责对话与路由（自然语言进），**工作流画布负责确定性执行**（节点图跑），两者通过"Agent 挂载工作流为技能"衔接——工作流就是 Agent 的工具。
- 图像创作场景则把图层画板**降级为工作流内的一个节点**，说明字节把"画布"理解为编排对象的一种数据类型，而非独立产品形态。
- 扣子空间（终端用户侧）走 Manus 式对话+多文件交付，不暴露画布。

**对比维度小结**：编排节点画布（非创作画布）｜人拖节点编排 + Agent 语义路由｜工具=插件/工作流/知识库/数据库｜一致性不适用｜无实时性｜**工作流版本管理 + 引用关系图**（治理亮点）。

**对「节点画布 vs agent 编排」的融合判断**（本报告分析）：
- Coze 证明两者不冲突：**画布是确定性的（人拖），Agent 是概率性的（模型路由），通过"工作流即 Agent 技能"接口互操作**。
- 委托方可类比的映射：wb_* 工具 = Coze 的"插件"，ComfyUI 模板 = Coze 的"工作流"，PLAN JSON 的 intent 路由 = Coze 的"开始节点语义分发"。差异在于 Coze 把这条链路全部显式化为用户可编排的画布，而委托方把它藏在黑盒里——**短期不必学 Coze 做全显式编排，但"试运行节点变绿 + 节点级输入输出查看"这种调试体验值得抄给 canvas_ops**。
- 开源的 coze-studio 可作为编排层实现参考（节点注册/连接校验/版本管理代码可直接读）。【官方仓库】

---

## 3. 逐产品分析（海外）

### 3.1 Krea AI

**产品形态**：AI 创意套件（图像/视频/实时生成/训练/节点）。【官方】[krea.ai](https://www.krea.ai/)。

**realtime canvas / infinite canvas 交互范式**：
- **Realtime**（【官方】[krea.ai/realtime](https://www.krea.ai/realtime)）：左侧画笔/形状/贴图 + 右侧**毫秒级实时生成区域**，边画边出图，强度/步数可调——委托方本地 ComfyUI 其实具备同款能力（latent/TAESD 预览）但从未产品化。
- **Enhance**：对生成结果局部/整体增强放大。
- **无限画布**：moodboard+生成混合画布，可摆放参考、框选区域生成、扩图；图层式而非节点式。【二手】[Reddit 发布讨论](https://www.reddit.com/r/aicuriosity/comments/1oq2o49/krea_ai_infinite_canvas_new_ai_art_tool_for/)；帮助文档站存在但抓取 403（[docs 目录](https://www.krea.ai/docs/user-guide/features/nodes)）。
- **Nodes**（【官方功能页】[krea.ai/features/nodes](https://www.krea.ai/features/nodes)）：**节点式工作流**统一图像/视频生成与编辑，把套件能力暴露成可连线的节点——Krea 同时运营「图层实时画布」与「节点工作流」两种画布，按任务复杂度分流。

**对比维度小结**：图层 realtime 画布 + 节点画布双形态｜inline 生成 + realtime paint 为主，agent 编排为辅｜工具=生成/增强/风格训练｜一致性=风格训练/参考图｜**实时性最强**｜历史/分支弱公开证据。

**可推断的实现信号**：
- Realtime 页面独立成入口（`/realtime`）且宣传口径强调毫秒级——推断其技术栈为快速蒸馏模型（SDXL-Turbo/FLUX-schnell 系）+ 流式解码，前端只做 canvas 合成；这与 ComfyUI 本地预览能力同源，委托方 #5 建议（预览直通）在技术上可达到同量级（中高置信）。【二手推断】
- Nodes 功能页强调「统一图像与视频」——推断节点后端是统一的 generation job API，节点只是参数编排外壳；对委托方的启示：wb_execute_template 的参数面做得越规整，未来「模板即节点」的转换越容易（中置信）。【二手推断】

### 3.2 Canva Magic Studio / Canva AI（Visual Suite 2.0）

**产品形态**：全民设计平台 + AI 助手。2025 年 Canva Create 发布 **Visual Suite 2.0**：【官方新闻稿】[canva.com/newsroom/news/canva-create-2025](https://www.canva.com/newsroom/news/canva-create-2025/)（403，标题与多方报道可证）——一次 prompt 生成**跨格式成套设计**（演示文稿+文档+网站+白板同源联动）。

**对话式设计 agent 怎么操作画布对象**：
- 「Ask Canva / 与 Canva AI 对话」可对既有设计下指令：改文案、换配色、重排、生成新页、批量变体，AI 直接修改画布上的图层对象。【官方帮助】[使用 Canva AI 通过对话优化设计](https://www.canva.com/zh_hk/help/canva-design-assistant/)、[基于 AI 的设计编辑](https://www.canva.com/zh_hk/help/edit-designs-with-ask-canva/)（正文 403，功能目录可证）。
- AI 助手总览：【官方】[canva.com/ai-assistant](https://www.canva.com/ai-assistant/)（写作/生成/改稿/品牌语音 Magic Switch 等全家桶）。

**画布架构**：经典**图层文档模型**（页/帧/图层），无节点。AI 操作画布的方式是「语义指令 → 结构化文档编辑」，用户可继续手动微调——**AI 产出与手动编辑完全同构**（这是与节点画布产品最大的差异：AI 的输出就是原生可编辑对象）。

**对比维度小结**：图层文档画布｜chat→直接改对象（同构编辑）｜工具=生成/改写/品牌资产/批量格式转换｜一致性=Brand Kit/风格锁定｜无实时 paint｜版本=设计历史与模板库。

**可推断的实现信号**：
- Visual Suite 2.0「一次 prompt 生成成套跨格式设计且同源联动」——推断其实现是 AI 先产出**结构化的品牌/内容中间表示**（文案、色彩、字体、版式 token），再分别渲染到文档/幻灯/网页画布；这比"每格式各生成一遍"的联动成本低得多（中置信，发布会口径推断）。【二手推断】
- Canva AI 对画布的修改与手动编辑完全同构（改完可继续手动拖）——推断其 agent 工具面直接操作文档对象模型（图层树），而非截图重绘；这是委托方 wb_canvas_ops 应对齐的「同构编辑」标准（高置信，产品行为可验证）。【二手实测】

### 3.3 Figma Make / Figma AI

**产品形态**：协作设计画布 + AI。两条 AI 线：
- **Figma Make**（【官方】[figma.com/make](https://www.figma.com/make/)）：prompt → 可运行的原型/应用（代码形态），产物落在 Figma 画布上，可继续对话迭代；官方博客给出 8 种用法（从原型到内部工具）。【官方】[8 Essential Tips for Using Figma Make](https://www.figma.com/blog/8-ways-to-build-with-figma-make/)
- **Figma AI**（【官方】[figma.com/ai](https://www.figma.com/ai/)）：画布内的第一稿生成、重命名图层、去背景等辅助。
- **画布对 Agent 开放**（【官方博客】[The Figma canvas is now open to agents](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/)）：通过 Figma MCP server，外部编码 agent 可以**读写真实画布节点**，实现 code-to-canvas 双向（【官方文档】[Code to canvas](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/)）。

**prompt→产物与画布/代码的融合思路**：Figma 把「设计画布（对象树）」与「代码」做成同一事物的两种投影，agent 从代码侧进入也能操作画布——**画布对 agent 的开放是通过 MCP 工具面实现的**，与委托方 wb_canvas_ops 思路同源，但 Figma 的工具面颗粒度到"每个节点属性"，而委托方目前主要是模板级操作。

**对比维度小结**：设计对象画布 + 代码双形态｜chat→生成/改对象（MCP 工具面）｜工具=生成/检索/代码执行｜一致性=设计系统/组件库｜无实时 paint｜版本=文件历史+分支（Figma 原生）。

**可推断的实现信号**：
- Figma 把画布开放给 agent 的工具颗粒度是**节点属性级**（读节点树、改属性、截图校验 code-to-canvas）——对照之下委托方 wb_canvas_ops 颗粒度是「模板/节点批量操作」，若未来要做 AI 精修画布（改某个节点参数、对齐某组连线），需要把工具面细化到单节点读写（高置信，官方 MCP 文档直接描述能力）。【官方确认】
- Figma Make 产物是「代码投影回画布」——说明其画布数据模型能承载非视觉对象（代码块/应用），无限画布被当作通用空间而非设计文档；委托方的 ComfyUI 画布其实同样可以承载笔记/素材/生成组，只差产品定义（中置信）。【二手推断】

### 3.4 Lovart（+ 国内版星流，见 2.5）

**产品形态**：多模态设计 Agent（web）。【官方发布稿】[Lovart Publicly Launches Multimodal Design Agent and ChatCanvas](https://www.lovart.ai/news/lovart-design-agent-public-launch-chatcanvas)（2025-07-28 正式版）。

**Agent 编排方式**：
- **ChatCanvas**：官方定义是"real-time workspace，用户与 agent 在此 think and build together"——单一无限画布上完成图像/视频/音频/品牌套件/3D 的生成与编辑，多模态提示词快速迭代，"从概念到可交付资产以分钟计"。
- Agent 自主多步：接 brief → 规划 → **并行调用多个专业工具**（生图/生视频/3D/排版模型）→ 画布交付全套成果（beta 期 30 万用户验证的是"品牌全案、分镜+动画+AR 滤镜一次交付"这类多模态编排任务）。
- 工作方法文档：【官方】[How Lovart Works](https://www.lovart.ai/docs/getting-started/how-lovart-works)（抓取失败，目录可证其存在）。
- 【二手】虎嗅对星流的评测（2.5 节已引）补足了国内版细节：方案树、工程化设计说明、处理链打包成工作流。

**对比维度小结**：agent 画布（图层式，无限）｜agent 自主多步 + ChatCanvas 人机共编｜工具=多模态生成模型矩阵｜一致性=参考案例库+迭代对话｜无实时 paint｜处理链可追溯。

**可推断的实现信号**：
- Lovart 官方口径「多模态提示词 + 单画布交付图像/视频/音频/品牌套件/3D」——推断其工具面是**模型路由器**：同一对话流后接多个专业模型 API，按任务阶段选用（生图选 Seedream 系、视频选 Kling/Veo 系），与星流评测观察到的「挑选合适工具（kontext 等）进行生图」一致（高置信）。【二手实测+官方】
- 「品牌全案一次交付」的 demo 形态说明其 agent 内部有**任务分解树**（logo→VI→应用物料逐级展开），且产物在画布上按设计稿版式自动排布——推断画布端有「结果自动布局」能力，而非简单网格堆叠（中置信）。【二手推断】

### 3.5 Flowith

**产品形态**：Agentic Workspace——「canvas + agent」双形态。【官方】[flowith.io](https://flowith.io/)（"Your Agentic Workspace"）、[Canvas 产品页](https://flowith.io/tools/canvas/)（"Visual AI Workspace for Branched Work"，抓取失败，标题/摘要可证）。

**范式**：无限画布上的**多线程 agent**：每个任务是一个可在画布上摆放、分支、并行的"线程节点"，AI 结果与用户笔记共存；NEO 版本强调自主任务执行。【二手】[Flowith Neo 深度介绍](https://skywork.ai/skypage/en/Flowith-Neo-A-Deep-Dive-into-the-Infinite-AI-Agent-Workspace/1972882188163674112)。工具面含搜索/生成/代码执行；一致性无专门机制；无实时 paint。

**Agent 编排细节**（【二手】同上）：线程（thread）是其编排原语——一次任务展开为一个 thread，thread 内可多步工具调用，thread 之间可在画布上并排/分叉对比；用户对 thread 的操作（重跑/分支/合并）即其"版本管理"。与 Flowith 的差异点：委托方的 thread 藏在会话列表里，Flowith 把 thread 铺在画布上变成空间对象——**"把 agent 执行轨迹画布化"是其对行业的独特贡献**。

### 3.6 Manus

**产品形态**：通用 Agent。云端沙箱 VM（网络/命令行/文件系统/浏览器）→ 桌面端 My Computer（本地 CLI 执行 + 每条命令需用户批准，可 Always Allow）。【官方博客】[Introducing My Computer](https://manus.im/blog/manus-my-computer-desktop)。

**工作台原型**：对话主界面 + **文件树/产物预览/浏览器录制回放**；虚拟机由 E2B 提供。【二手】[How Manus Uses E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)。Wide Research 提供 fan-out 多 agent 并行。【官方】[features/wide-research](https://manus.im/features/wide-research)。

**要点**：Manus 证明"没有画布"也能成立——它的画布是**文件系统**；对所有动作（尤其本地命令）做审批门。委托方的审批门（AG-UI 审批）与其同构。

**对委托方的可借鉴点**：Manus 桌面端的「每条命令弹审批，可 Always Allow」粒度控制，对应委托方 wb_* 工具分级（读类免审批 / 写画布类弹审批 / 提交生成类弹审批+积分提示）；目前委托方审批策略是全局 approve，可按工具危险级别分层（中等工作量，与建议 #3 的计划拍板卡可共用前端通道）。

### 3.7 Genspark

**产品形态**：Super Agent（mixture-of-agents：多 LLM + 工具池自动路由，含 AI Sheets/AI Slides/AI Designer/生图/通话）。【官方帮助目录】[Super Agent](https://www.genspark.ai/helpcenter/super-agent)（403）、【官方博客】[Introducing Genspark AI Sheets](https://www.genspark.ai/blog/genspark-ai-sheets)（403，标题可证）。

**AI Sheets**：把表格的每一行变成一个 agent 任务，批量跑研究/生成——「批量队列」的产品化形态。【二手解析】[Floatboat: Genspark Super Agent Explained](https://floatboat.ai/blog/genspark-super-agent-explained)。无画布；交互是聊天+结构化产物（sheets/slides/呼叫）。

**对委托方的启示**：Genspark 证明「批量」单独成为一级入口有价值。委托方的批量队列目前是工作台的附属功能；对标做法是给批量任务一个表格视图（每行=一次生成，列=参数/状态/产物），Agent 可直接对表格操作（"把这 20 个 SKU 都换成圣诞背景"）——与建议 #4（资产层）配合后，批量一致性任务的表达力会明显强于 Genspark（其无生成资产概念）。

### 3.8 Freepik / Magnific Spaces 与 Kosmos

**产品形态**：Freepik（现 Magnific 品牌整合）AI Suite 的**创合作业区 Spaces**。【官方页面】[magnific.com/spaces](https://www.magnific.com/spaces)（403，但页面标题"Node Based Canvas Image & Video"即核心答案）+ 官方教学视频【二手/官方学院】[Navigating Spaces](https://www.youtube.com/watch?v=SfBjTAjxwiU)、[Build your first creative AI workflow in Spaces](https://www.youtube.com/watch?v=AWcvnBDsnY0)。

**画布架构**：**节点式创合画布**：moodboard 素材区 + 可连线节点（生成/编辑/放大/视频化等，挂自家多模型：Mystic/Flux/Seedream/Kling/Veo 等），图像与视频在同一条节点链上流转。既是 moodboard（自由摆放参考）又是 workflow（连线执行）。Kosmos 为其生态中的 AI 素材/助手组件（公开细节少，【二手】社区讨论为主，不展开）。

### 3.9 Adobe Firefly Boards

**产品形态**：Firefly Web 里的 moodboard 式创合画布。【官方帮助】[About Firefly Boards](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/about-firefly-boards.html)、[Create boards](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/create-mood-boards.html)。

**能力拼图**（全部来自 helpx 官方目录，可抓取验证）：
- **多模型并排**：Firefly 模型族 + Flux / GPT Image / Imagen / Gemini / Ideogram / Runway / Kling / Seedance 等伙伴模型在同一个板子里生成（helpx 目录逐模型成页）。
- **迭代变体**：生成 → 变体 → 局部编辑（文字指令编辑、Markup 手写标注编辑、Generative Fill/Remove/Expand、Precision Flow beta）。
- **参考体系**：风格参考图、构图参考（Match image composition）、Style Kits（企业共享风格库）、Custom Models（自定义模型训练）。
- 同一帮助站还有企业级 **Creative Production**：节点式批量工作流（输入/输出节点、模板与数据合并节点、批量换底/裁剪/调色）——Adobe 同时运营 Boards（创合）与 Creative Production（生产管线）两层。

**对比维度小结**：moodboard 画布｜inline 生成 + 变体迭代（非 agent 编排为主）｜工具=多厂商模型矩阵｜一致性=参考图/风格库/自定义模型｜无实时 paint｜变体树即版本。

**可推断的实现信号**：
- helpx 目录显示 Boards 的编辑能力分三层：文字指令编辑 / Markup 手写标注编辑 / Precision Flow（beta，推断为区域级精细编辑管线）——三层对应三种用户意图颗粒度，是「AI 编辑入口」的完整设计谱系（高置信，官方目录成页）。【官方确认】
- 多厂商模型（Flux/GPT Image/Imagen/Gemini/Ideogram/Runway/Kling/Seedance）在同一 Board 内并列——推断其生成任务层有统一的 job 抽象屏蔽各家 API 差异，与委托方「wb_execute_template 屏蔽 ComfyUI workflow 差异」同构；Adobe 甚至把竞品模型当作自家画布的工具，**"多模型宿主"是创合画布的平台化打法**（高置信）。【官方确认】
- 企业侧 Creative Production 是节点式批量管线（输入/输出/模板/数据合并节点）——Adobe 的完整版图 = Boards（灵感创合）+ Creative Production（确定性生产），双画布分层与 Krea（realtime+nodes）、RunningHub（无限画布+经典工作流）一致：**"轻画布给灵感、节点图给生产"正在成为全行业默认分工**（高置信）。【官方确认】

---

## 3A. 横切范式归纳（九家横评）

把上述产品按四个轴横切，得到行业收敛图景：

**轴 1：画布范式光谱**（从重到轻）

| 范式 | 代表 | 特征 |
|---|---|---|
| 编排节点图 | Coze、Firefly Creative Production | 节点=逻辑/数据变换，人拖为主，确定性执行 |
| 创作节点图 | ComfyUI、RunningHub 经典、Krea Nodes、Magnific Spaces | 节点=生成步骤，可连线可复用 |
| 画布原生 Agent | RunningHub RHTV、Lovart/星流 | Agent 在图层/节点混合画布上自主操作，过程可视 |
| 图层 moodboard | 即梦、Krea 无限画布、Firefly Boards | 自由摆放+框选生成+变体迭代 |
| 陈列型画布 | MiniMax 桌面端 | 文件+标注回传，画布是产物视图不是操作面 |
| 无画布 | 可灵、万相、Genspark、Manus | 表单/时间线/文件树承载 |

**轴 2：AI 驱动方式光谱**（对委托方最有意义的轴）

| 驱动方式 | 代表 | 委托方位置 |
|---|---|---|
| inline 生成（框哪生成哪） | Krea realtime、Firefly 框选 | 缺 |
| chat→直改对象（同构编辑） | Canva、即梦、Figma(MCP) | 部分（canvas_ops 有工具无体验） |
| chat→plan→工具单轮 | 委托方现状 | **在这里** |
| agent 多步自检（结果回流） | RHTV、星流、Lovart | 缺（harness P1 目标） |
| agent 自动建节点 | RHTV | 缺（#2 建议目标） |

**轴 3：一致性机制三级**
1. 模型级：Seedream 4.0 多图参考/多图输出、可灵多主体——靠模型能力，产品零成本。
2. 资产级：RHTV 角色资产表、可灵元素库、Firefly Style Kits、Canva Brand Kit——平台把一致性对象结构化，跨会话复用。
3. 工程级：LoRA/种子/ControlNet（ComfyUI 原生、Tensor.Art）——可控性最强、门槛最高。
委托方卡在第 3 级（工程能力有但暴露给 AI 的只有模板参数），建议（#4）直接跳到资产级。

**轴 4：人机控制权光谱**
- 全自动型：Hailuo Video Agent Stage3、Genspark。
- 步进拍板型：RHTV（每步可暂停）、星流（方向选择）、Manus（每命令审批）。
- 人在环上型：Canva/Figma（AI 改完人继续手改）、Krea（手画 AI 生成）。
委托方的审批门属于第三类，但缺少第二类的「计划卡+选项拍板」交互——建议（#3）补的正是这个中间档，行业实测显示步进拍板型用户信任度最高（RHTV 整篇卖点即"每步看得见、可干预"）。

**三个全行业趋势判断**：
1. **「轻画布给灵感、节点图给生产」双画布分层**成为平台标配（Krea/Firefly/RunningHub 三家独立验证）。
2. **协议标准化**（AG-UI/ACP/MCP）让「画布 agent」的护城河只剩工具面颗粒度与资产层——UI 事件流本身不再构成差异。
3. **一致性是 2025–2026 的主战场**：各家发布会强调的点从"画质"全部转向"多图一致/角色一致"，模型层（Seedream 4.0）与资产层（Style Kits）双线推进。

---

## 4. 编排协议基础设施（对照委托方通道）

- **AG-UI**（【官方】[Events 规范](https://docs.ag-ui.com/concepts/events)）：事件分生命周期（RunStarted/Finished/Error、StepStarted/Finished）、文本流（TextMessage*）、工具卡（ToolCallStart/Args/End/Result/Chunk）、状态（StateSnapshot/Delta）、Reasoning 流、Custom/Generative UI（草案）。委托方已对齐 21 种事件——**行业里 Headless agent（如 RHTV 画布 agent、Lovart）普遍就是「agent 事件流 + 前端渲染工具卡/步骤」这套**，委托方协议侧不落后。
- **ACP**（【官方】[Introduction](https://agentclientprotocol.com/get-started/introduction)、[Architecture](https://agentclientprotocol.com/get-started/architecture)）：JSON-RPC over stdio，agent 作为编辑器子进程，客户端把用户配置的 **MCP server 配置转发给 agent 直连**（或走 stdio 代理回环），权限用双向 request。委托方外部通道"ACP mcpServers 注入（wb_* 工具面挂给外部 agent）"正是官方演进路线（`external-agent-architecture.md` 已列为未做项）——**做完它，Kimi/Qwen 等 40+ CLI 就能像内置引擎一样操作画布**。
- 判断：协议层（AG-UI/ACP/MCP）已是行业公共底座，差异化全在**工具面颗粒度**与**画布对象模型**上。

---

## 5. 差距对照表（委托方 vs 各家）

委托方现状（依据仓库文档）：Electron + 无限节点画布（用户手动连线）；AI 工作台 chat → PLAN JSON（intent: image/batch/chat/memory/canvas_ops）→ 本地校验 → wb_* MCP 工具执行；ACP 40+ CLI + Claude Code 外部通道；AG-UI SSE（思考/正文/工具卡/审批门）；会话/预设/批量队列/记忆；**单轮决策、执行结果不回流模型**（`workbench-harness-architecture.md` §1.3）。

| 维度 | 委托方现状 | 即梦无限画布 | RunningHub RHTV | Lovart/星流 | Krea | Firefly Boards | Coze | MiniMax | Figma |
|---|---|---|---|---|---|---|---|---|---|
| 画布范式 | 节点图（手动连线） | 图层 moodboard + chat | 节点图 + 画布原生 Agent | Agent 画布（图层+处理链） | 图层 realtime + 节点双形态 | moodboard | 编排节点图 | 文件陈列画布 | 对象画布+代码 |
| AI 驱动方式 | chat→PLAN JSON→工具（单轮） | chat Agent 直改对象（黑盒） | **agent 多步 + 自动建节点 + 每步拍板** | chat→方案树→工具→自检重试 | inline/realtime 生成 | 变体迭代 | 人拖节点+agent 路由 | chat→文件产物 | chat/MCP→改对象 |
| 执行结果回流模型 | ✗（前端 autoRecover 补） | 不适用（模型即产品） | ✓（自检再生成） | ✓（不满足自动重生成） | 不适用 | 不适用 | ✓（工作流输出回节点） | ✓ | ✓ |
| 工具面给 agent | wb_*（模板/生成/批量/canvas_ops/同步） | 模型能力内嵌 | 全域模型+工作流+剪辑+分镜 | 多模态模型矩阵 | 生成/增强/训练 | 多厂商模型矩阵 | 插件/工作流/知识库 | 代码/搜索/生成/浏览器 | 画布节点读写 |
| 一致性机制 | 模板+手动种子 | Seedream 多图参考/多图输出 | **角色资产设定表** | 参考案例库+迭代对话 | 风格训练 | 参考图/Style Kits/自定义模型 | — | — | 设计系统 |
| 实时性 | 无预览直通 | 秒级批量 | 过程可视化 | 过程可视化 | **realtime paint** | 快速生成 | — | — | — |
| 版本与历史 | 无画布快照 | 资产历史 | **一键打包成工作流复用** | 处理链打包可追溯 | 弱 | 变体树 | 工作流版本+引用图 | 任务历史 | 文件历史 |
| HITL | 审批门（工具级） | 追加对话 | **每步可暂停/干预/局部改** | 方向选择+Tab 快改 | 手动微调 | 手动微调 | 单节点调试 | 命令审批 | — |

**结论性判断**：
1. 协议/通道层（AG-UI、ACP、MCP、审批门、批量队列）委托方**不落后**，个别（外部 agent 注入工具面）做完即到一线水平。
2. 真正的差距集中在三处：**agent 循环闭环**（多轮+结果回流+自检）、**画布原生 agent 产品化**（自动建节点+过程可视+步级干预）、**一致性资产层**（角色/风格/种子成为工具面一等公民）。
3. 版本管理是全行业短板（除 Coze 治理向），补上即是差异化。

---

## 6. 差距根源与建议（按性价比排序）

**根源分析**：
- 根源 A（架构）：`decide` 把 harness 阉割成单轮 JSON 决策器——工具执行在路由层、结果不进模型上下文、Thread 每轮销毁（`workbench-harness-architecture.md` §1.2/1.3 已完整诊断）。RHTV/星流的"自检重生成""每步汇报"全部依赖这个闭环，这是所有上层体验的地基。
- 根源 B（产品）：canvas_ops 是侧信道工具而非主路径——用户看不到 AI"在画布上搭工作流"的过程，感知不到 AI 在干活；对标 RHTV 的差异全在"过程可视化 + 步级干预"。
- 根源 C（数据模型）：缺少「创作资产」抽象——角色/风格/参考图/种子没有进入 wb_* 工具面，一致性只能靠用户在聊天里贴图；画布没有快照层，AI 操作不可回滚。

**建议清单**（利用已有资产：ComfyUI 引擎、wb_* 工具面、AG-UI 流式、ACP/Claude 通道；估值为纯开发人天，不含灰度观察）：

| # | 建议 | 对标 | 量级 | 说明 |
|---|---|---|---|---|
| 1 | **落地 harness 化 P1**：Thread 会话化 + 执行结果回流模型（wb_execute_template wait 模式补 wb_get_outputs/wb_attach_previous），PLAN JSON 降级为快路径 | RHTV/星流自检闭环；`workbench-harness-architecture.md` §4 已有完整设计 | 5–8 天 | 解决「模型看不到结果、上下文断裂、autoRecover 补锅」三病根，是其余建议的地基 |
| 2 | **wb_build_workflow**：Agent 从模板 JSON 自动生成节点+边+自动布局，一键落画布；配合既有 wb_canvas_sync 做增量同步 | RHTV「画布内自动批量生成节点、搭建整套工作流」 | 8–12 天 | 委托方与 RHTV 的核心差距点；模板库已有，缺的只是"模板→画布节点图"的生成器与布局算法（分层/力导向均可） |
| 3 | **计划步骤卡 + 中途拍板**：把 agent 的多步计划渲染为 AG-UI 步骤树卡片，关键分歧点（风格方向/参数清单）发选项让用户点选后继续 | RHTV「三个方向拍板/参数清单勾选」、星流「4 方向」、Coze 多 agent 路由 | 3–5 天 | AG-UI 已有工具卡与 Custom 事件，只差 plan-step 卡片组件与 confirm 交互协议 |
| 4 | **创作资产层 wb_assets**：角色/风格资产 =（参考图组 + 种子 + LoRA/模板参数）打包，注册为 wb_* 可引用对象；生成时自动挂载 | RHTV 角色资产设定表、可灵元素库、Firefly Style Kits | 5–8 天 | 一致性从"用户贴图"升级为"Agent 自动维护"；与 #1 的 wb_attach_previous 合并实现可省 2 天 |
| 5 | **生成过程直通预览**：本地 ComfyUI 预览帧（latent/TAESD preview）经 AG-UI 进度事件直通前端进度卡 | Krea realtime 的低配版、RHTV 过程可视 | 3–5 天 | 本地引擎独有优势（云平台做不到零拷贝预览）；只改预览 meta 采集 + SSE 事件复用 |
| 6 | **画布快照与回滚**：LiteGraph serialize 定期快照 + AI 操作前自动快照 + 历史面板恢复 | 星流处理链追溯、Figma 历史 | 3–4 天 | AI 改画布的安全网，#2 的前置保险；LiteGraph 序列化能力现成 |
| 7 | **ACP mcpServers 注入**：外部 agent（Kimi/Qwen/Claude）经 MCP 注入完整 wb_* 工具面，与内置引擎同权操作画布 | ACP 官方架构推荐路径（第 4 节） | 4–6 天 | `external-agent-architecture.md` 已列演进方向；做完后"40+ CLI 都能排 workflow"是独有卖点 |
| 8 | **画布操作反向沉淀为模板**：用户/AI 在画布上的成功操作链一键保存为可复用模板（参数化），进入模板库与记忆 | RHTV 一键打包工作流、星流处理链打包 | 5–8 天 | 让模板库从"人工上架"变成"用出来的"，飞轮起点 |

**推荐实施顺序**：#1（地基）→ #6（安全网）→ #2 + #3（旗舰体验，可并行）→ #4 → #5 → #7 → #8。第一梯队（#1/#2/#3/#6）约 **19–29 人天**，即可在产品叙事上完成"画布原生 Agent"对标；全清单 36–56 人天。
**不做清单**（明确放弃，避免资源分散）：realtime paint 全屏化（Krea 级，需改引擎渲染链，云成本/复杂度高，#5 低配版足够）；自研节点式视频时间线（RHTV 的剪辑器重资产，可后期用 ComfyUI 视频节点链替代）；数字人/3D 新画布形态。

---

## 7. 参考链接清单

**中国产品**
- 即梦 AI 官网：https://jimeng.jianying.com/
- 即梦画布扩图官方帮助：https://jimeng.jianying.com/features/resource/ai-expand-image
- 即梦无限画布入口（实测引用）：https://jimeng.jianying.com/ai-tool/assets-canvas
- 即梦无限画布实测（人人都是产品经理，二手）：https://www.woshipm.com/ai/6292231.html
- Seedream 4.0 官方发布：https://seed.bytedance.com/zh/blog/不止会-画-更会-想-seedream-4-0-图像创作模型正式发布
- Seedream 4.0 产品页：https://seed.bytedance.com/zh/seedream4_0
- MiniMax Agent：https://agent.minimax.io/ ／ https://agent.minimaxi.com/
- MiniMax Code 工作区文档：https://agent.minimaxi.com/docs/code/workflows/workspace
- MiniMax 桌面端无限画布文档：https://agent.minimaxi.com/docs/code/desktop/infinite-canvas
- Hailuo Video Agent 官方发布：https://www.minimax.io/news/video-agent
- MiniMax Agent 功能页：https://agent.minimaxi.com/features/zh.html
- 可灵 AI 官网：https://kling.ai/cn ／ 创作台：https://klingai.com/app ／ 文档：https://www.klingai.com/docs
- 可灵角色一致性指南：https://kling.ai/quickstart/ai-video-character-consistency
- Kling 3.0 一致性（二手）：https://www.atlascloud.ai/zh/blog/tips/how-to-use-kling-3-0-for-character-consistency
- 量子位智库 AI 100（多模态输入成标配）：https://hub.baai.ac.cn/view/49620
- 通义万相企业版基础功能（阿里云帮助）：https://help.aliyun.com/zh/model-studio/wanxpro-basic-function
- 百炼智能体应用：https://help.aliyun.com/zh/model-studio/single-agent-application
- LibLibAI 官网：https://www.liblib.art/
- LibLib 在线 ComfyUI 教学（扩图/放大）：https://www.liblib.art/teaching/388fcb1b3f5b42838bc20af2cfdf9351 ／ https://www.liblib.art/teaching/7d94074fa3684dba9e713dc66855abc9
- 星流 Agent 官网（含停服公告）：https://www.xingliu.art/
- 星流上线报道（开源中国）：https://www.oschina.net/news/358708
- 星流深度评测（虎嗅/硅星人）：https://www.huxiu.com/article/4543329.html
- Tensor.Art 官网：https://tensor.art/ ／ 工作流示例：https://tensor.art/workflows/817655451259990898 ／ 介绍（AIbase）：https://top.aibase.com/tool/tensor-art
- RunningHub 官网：https://www.runninghub.cn/
- RHTV 深度实测（量子位）：https://www.qbitai.com/2026/05/413912.html
- RunningHub 无限画布上线（凤凰，二手）：https://baby.ifeng.com/c/8r5RzNXHzpo
- 扣子低代码工作流文档：https://docs.coze.cn/guides_use_workflow
- 扣子多 Agent 模式：https://docs.coze.cn/guides_multiagent
- 扣子画板节点：https://docs.coze.cn/guides_canvas_node
- 扣子空间：https://www.coze.cn/space-preview
- Coze Studio 开源：https://github.com/coze-dev/coze-studio

**海外产品**
- Krea 官网：https://www.krea.ai/ ／ Realtime：https://www.krea.ai/realtime ／ Nodes：https://www.krea.ai/features/nodes ／ Nodes 文档：https://www.krea.ai/docs/user-guide/features/nodes
- Krea 无限画布（社区）：https://www.reddit.com/r/aicuriosity/comments/1oq2o49/krea_ai_infinite_canvas_new_ai_art_tool_for/
- Canva Visual Suite 2.0 新闻稿：https://www.canva.com/newsroom/news/canva-create-2025/
- Canva AI 助手：https://www.canva.com/ai-assistant/ ／ 对话式设计帮助：https://www.canva.com/zh_hk/help/canva-design-assistant/
- Figma Make：https://www.figma.com/make/ ／ Figma AI：https://www.figma.com/ai/
- Figma 画布对 agent 开放（官方博客）：https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/
- Figma MCP code-to-canvas：https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/
- Figma Make 用法（官方博客）：https://www.figma.com/blog/8-ways-to-build-with-figma-make/
- Lovart 正式版发布（ChatCanvas）：https://www.lovart.ai/news/lovart-design-agent-public-launch-chatcanvas
- Lovart 工作方法文档：https://www.lovart.ai/docs/getting-started/how-lovart-works
- Flowith：https://flowith.io/ ／ Canvas：https://flowith.io/tools/canvas/
- Manus My Computer（官方博客）：https://manus.im/blog/manus-my-computer-desktop
- Manus 虚拟机（E2B，二手）：https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers
- Manus Wide Research：https://manus.im/features/wide-research
- Genspark Super Agent 帮助：https://www.genspark.ai/helpcenter/super-agent ／ AI Sheets 博客：https://www.genspark.ai/blog/genspark-ai-sheets ／ 解析（二手）：https://floatboat.ai/blog/genspark-super-agent-explained
- Magnific（原 Freepik）Spaces：https://www.magnific.com/spaces ／ 教学视频：https://www.youtube.com/watch?v=SfBjTAjxwiU
- Adobe Firefly Boards 帮助：https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/about-firefly-boards.html ／ https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/create-mood-boards.html

**协议**
- AG-UI 事件规范：https://docs.ag-ui.com/concepts/events ／ 总览：https://docs.ag-ui.com/introduction
- ACP 介绍/架构：https://agentclientprotocol.com/get-started/introduction ／ https://agentclientprotocol.com/get-started/architecture
