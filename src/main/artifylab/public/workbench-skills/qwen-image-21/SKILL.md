---
name: qwen-image-21
description: Qwen-Image-2.1（7B，2026-09-20 开源）最佳实践——一个 checkpoint 统一文生图/图像编辑/原生 RGBA 透明图/多参考图合成，含三场景工作流、cfg=1 参数口径、抠图 resolution=0 关键项、RGBA alpha 合成与 autogrow 扁平键等实测坑。用户需求涉及透明图/抠图/换装编辑/多图合成或点名 Qwen-Image-2.1 时使用。
---

# Qwen-Image-2.1 工作流与提示词最佳实践

## 模型事实卡

- **架构**：7B Single-Stream DiT（32 层）+ Qwen3-VL 8B 文本/参考图编码器 + 64 通道 **RGBA** VAE（16× 压缩）
- **开源**：2026-09-20，Qwen Research License（非商用）。注意与 1.0（20B，Apache 2.0）不同
- **ComfyUI 支持**：Day-0 原生，需 **ComfyUI ≥ 0.36**（`TextEncodeQwenImage21` not in list 即版本过旧）
- **一个 checkpoint 四件事**：文生图 / 指令式图像编辑 / **原生 RGBA 透明图**（alpha 随采样直接生成，目前唯一做到的主流开源模型）/ 多参考图合成（≤10 张，Prefix KV Cache 让参考图只编码一次，多图反而快）
- **原生 2K**：2048×2048 起，16:9 到 2752×1536
- **中英文图内文字渲染**开源第一档

## 三场景工作流（官方模板）

| 场景 | 模板 | 要点 |
|---|---|---|
| 文生图 | `QWEN21_T2I` | 25 步 euler/simple，cfg=1 |
| 图像编辑 | `QWEN21_IMAGE_EDIT` | 双参考图 + `QwenImage21Cache` KV 复用；换装后同人同景同姿势保持好 |
| RGBA 抠图 | `QWEN21_RGBA_BACKGROUND_REMOVAL` | **resolution=0 是成败关键**，见下 |

## 节点栈

- **`TextEncodeQwenImage21`**：2.1 专用文本编码节点（不是普通 CLIPTextEncode）
- **`QwenImage21Cache`**：Prefix KV Cache——参考图只编码一次，多图编辑/多轮编辑复用
- **`CLIPLoader` `type=qwen_image`**：**w4a8 TE（6.31GB）可直载**，无需 9.35GB int8 TE
- 模型文件三件套见 `model-registry` 技能（int8_convrot DiT 7.26GB / w4a8 TE / RGBA VAE 0.68GB）

## 参数口径（本机 12GB 实测验证）

- **steps 25、sampler `euler`、scheduler `simple`、cfg=1 + 空负向**——官方模板全家都是 cfg=1 蒸馏口径，质量词/负面词无效，别浪费 token
- **12GB（RTX 4070）全程无 OOM**：DiT 常驻 7.3GB + TE 每 prompt 只跑一次可卸载；单张 20-40 秒含缓存
- 原生 2K 直接写分辨率即可；小图 1024² 也正常

## RGBA 抠图（独有能力，最易踩坑）

- **`resolution=0`（参考图原尺寸拼接）是采样稳定的关键**——设 1024 直接出纯噪点（实测教训）
- **输出背景区 RGB 是噪声、靠 alpha 遮罩生效**——下游消费必须做 alpha 合成，别直接看 RGB
- **所有输出原生 RGBA 模式（T2I 也是）**——alpha 通道可当免费软掩码用
- 效果：发丝级遮罩干净；合成白底验证无残留

## 提示词最佳实践

- **自然语言，词序=权重，前置优先**（Qwen3-VL 8B 编码器，中文/英文均可，30–80 词）
- **图内文字**：引号包住要渲染的字，如 霓虹招牌写着"营业中"
- **编辑类：先锁不变项，再写唯一改动**——`Keep {人物/构图/光照} exactly the same. Change only {改动}.`；动作词优先 Add / Change / Make / Remove / Replace（与 prompt-engineering 编辑共识一致）
- **多参考图**：每张图都要有明确分工（"图 1 的人物 + 图 2 的服装"），写在引用它的句子前
- **多轮编辑**：每轮重新锚定服装与不变项，否则逐轮漂移

## API / 工程坑（/prompt 直调必读）

- **autogrow 参考图必须用扁平键** `"images.image_1": ["9", 0]`——嵌套 dict 或列表会被**静默忽略**（min=0 校验放行，纯 T2I 幻觉输出）
- **LoadImage 引用必须真实定义的节点**——引用不存在节点 + autogrow 可选输入 = 参考图静默丢失
- 抠图模板的 `resolution` 控件默认值若被改成 1024 会全噪，保持 0

## 已知短板（如实告知用户）

- 写实图偶发**十字纹理**；复杂姿势**手脚**仍会出错
- 参考图 ≥3 张一致性开始下降（发色/发型级别漂移）
- 官方 40 步起步偏慢，**社区蒸馏 LoRA 尚未发布**——出了再更新加速口径（关注 LightX2V 系）

## 验证状态

本机 RTX 4070 12GB / ComfyUI 0.37.0 三场景端到端跑通（2026-09-21）：T2I 1024² RGBA 质量高；EDIT 换装同人同景保持好；RGBA 抠图发丝级。以上参数口径均为实测，非文档抄写。

## Sources

- **官方**：魔搭 `Comfy-Org/Qwen-Image-2.1`（Comfy-Org 重打包，国内直连）；工作流模板抓自 Comfy-Org/workflow_templates
- **Empirical**：本机三场景实测（tmp/test_qwen21_t2i.py、tmp/test_qwen21_edit_rgba.py）；社区反馈来自 Reddit/X 早期用户
