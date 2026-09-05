<template>
  <a-modal
    :open="open"
    :title="c.title"
    :footer="null"
    width="820px"
    @update:open="(v) => $emit('update:open', v)"
  >
    <div class="max-h-[70vh] space-y-5 overflow-y-auto py-2 pr-1">
      <!-- 场景速览：一键开始 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-rocket text-[var(--wb-accent)]"></i>{{ c.scenarioTitle }}
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div
            v-for="s in SCENARIOS"
            :key="s.id"
            class="group relative overflow-hidden rounded-[10px] border border-[var(--wb-stroke)] bg-[var(--wb-surface-deep)] transition hover:border-[var(--wb-accent)]"
          >
            <div class="relative h-32 w-full overflow-hidden">
              <video
                v-if="s.video"
                class="absolute inset-0 h-full w-full object-cover opacity-90 transition duration-200 group-hover:scale-105 group-hover:opacity-100"
                :src="s.video"
                :poster="s.image"
                muted
                loop
                playsinline
                @mouseenter="playVideo"
                @mouseleave="pauseVideo"
              ></video>
              <img
                v-else
                class="absolute inset-0 h-full w-full object-cover opacity-90 transition duration-200 group-hover:scale-105 group-hover:opacity-100"
                :src="s.image"
                :alt="s.title[lang]"
                loading="lazy"
              />
              <div
                class="absolute inset-0 bg-[rgba(8,10,18,0.85)]"
              ></div>
              <div class="absolute inset-x-0 bottom-0 p-3">
                <div class="text-sm font-semibold text-white drop-shadow">{{ s.title[lang] }}</div>
                <div class="mt-0.5 line-clamp-1 text-[11px] text-[var(--wb-text-2)]">
                  {{ s.desc[lang] }}
                </div>
              </div>
              <span
                v-if="s.video"
                class="absolute right-2 top-2 rounded-full bg-[var(--wb-surface)] px-2 py-0.5 text-[10px] text-[var(--wb-text-2)]"
              >
                <i class="fas fa-circle-play mr-1"></i>{{ c.hoverPlay }}
              </span>
            </div>
            <div class="flex items-center gap-2 p-3 pt-2.5">
              <p class="line-clamp-2 flex-1 text-[11px] leading-relaxed text-[var(--wb-text-3)]">
                {{ s.prompt[lang] }}
              </p>
              <button
                class="shrink-0 rounded-lg bg-[var(--wb-accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 active:scale-95"
                @click="$emit('start', s)"
              >
                <i class="fas fa-bolt mr-1"></i>{{ c.startBtn }}
              </button>
            </div>
          </div>
        </div>
        <div class="mt-1.5 text-[11px] text-[var(--wb-text-3)]">{{ c.scenarioFoot }}</div>
      </section>

      <!-- 三种模式 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-layer-group text-[var(--wb-accent)]"></i>{{ c.modesTitle }}
        </h3>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div
            v-for="m in c.modes"
            :key="m.name"
            class="rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface-deep)] p-3 transition hover:border-[var(--wb-accent)]/40"
          >
            <div class="mb-1 text-xs font-medium text-[var(--wb-accent)]">{{ m.name }}</div>
            <div class="text-[11px] leading-relaxed text-[var(--wb-text-2)]">{{ m.desc }}</div>
          </div>
        </div>
      </section>

      <!-- 预设 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-bolt text-[var(--wb-accent)]"></i>{{ c.presetsTitle }}
        </h3>
        <div class="space-y-1.5">
          <div
            v-for="p in c.presets"
            :key="p.name"
            class="group flex items-start gap-2 rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface-deep)] px-3 py-2 transition hover:border-[var(--wb-accent)]/40"
          >
            <span class="shrink-0 text-xs font-medium text-[var(--wb-accent)]">{{ p.name }}</span>
            <span class="flex-1 text-[11px] leading-relaxed text-[var(--wb-text-2)]">{{
              p.desc
            }}</span>
            <button
              class="shrink-0 rounded-md border border-[var(--wb-accent)]/40 px-2 py-0.5 text-[11px] text-[var(--wb-accent)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--wb-accent)]/10"
              @click="$emit('start', { presetId: p.id })"
            >
              {{ c.startBtn }}
            </button>
          </div>
        </div>
        <div class="mt-1.5 text-[11px] text-[var(--wb-text-3)]">{{ c.presetsFoot }}</div>
      </section>

      <!-- 模板与斜杠 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-wand-magic-sparkles text-[var(--wb-accent)]"></i>{{ c.templatesTitle }}
        </h3>
        <p class="text-[11px] leading-relaxed text-[var(--wb-text-2)]">{{ c.templatesBody }}</p>
      </section>

      <!-- 技能库 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-book text-[var(--wb-accent)]"></i>{{ c.skillsTitle }}
        </h3>
        <p class="text-[11px] leading-relaxed text-[var(--wb-text-2)]">{{ c.skillsBody }}</p>
      </section>

      <!-- 提示词库与素材库 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-images text-[var(--wb-accent)]"></i>{{ c.libTitle }}
        </h3>
        <ul class="space-y-1 text-[11px] leading-relaxed text-[var(--wb-text-2)]">
          <li v-for="line in c.libItems" :key="line" class="flex gap-1.5">
            <span class="text-[var(--wb-accent)]">·</span><span>{{ line }}</span>
          </li>
        </ul>
      </section>

      <!-- 小贴士 -->
      <section>
        <h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
          <i class="fas fa-lightbulb text-[var(--wb-accent)]"></i>{{ c.tipsTitle }}
        </h3>
        <ul class="space-y-1 text-[11px] leading-relaxed text-[var(--wb-text-2)]">
          <li v-for="line in c.tips" :key="line" class="flex gap-1.5">
            <span class="text-[var(--wb-accent)]">·</span><span>{{ line }}</span>
          </li>
        </ul>
      </section>

      <div class="border-t border-[var(--wb-stroke)] pt-2 text-[10px] text-[var(--wb-text-3)]">
        {{ c.credit }}
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/utils/i18n'
import { SCENARIOS } from '../demoScenarios'

defineProps({ open: { type: Boolean, default: false } })
defineEmits(['update:open', 'start'])

const { getCurrentLanguage } = useI18n()
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

function playVideo(e) {
  e.target?.play?.().catch(() => {})
}
function pauseVideo(e) {
  e.target?.pause?.()
}

const CONTENT = {
  zh: {
    title: 'AI 工作台使用指南',
    scenarioTitle: '场景速览 · 一键开始',
    scenarioFoot:
      '点击「一键开始」：自动创建对应预设的会话、填入示例提示词（图生图场景还会附带示例参考图），直接发送即可看到效果。',
    startBtn: '一键开始',
    hoverPlay: '悬停预览',
    credit: '示例封面与视频来自 Unsplash / Pexels（免费许可，可商用）',
    modesTitle: '三种工作台模式',
    modes: [
      {
        name: 'A · 独立工作台',
        desc: '从左侧菜单进入的完整工作台：对话生成、会话管理、模板工厂（把成功的会话固化成可复用应用）、产物面板。新手从这里开始。',
      },
      {
        name: 'C · ComfyUI 侧栏',
        desc: '在 ComfyUI 界面右侧内嵌的轻量会话栏：不打断画图流程，随手让 agent 改工作流、查模型、跑生成。',
      },
      {
        name: '画布 · AI 侧栏',
        desc: '无限画布左下角唤起的 AI 面板：选中画布上的图片/笔记发给 agent 做参考图生成，产物自动落回画布并与来源连线。',
      },
    ],
    presetsTitle: '预设（会话级「人格」）',
    presets: [
      { id: 'standard', name: '标准', desc: '无约束，AI 自由决策意图与模板，适合探索。' },
      { id: 'text-to-image', name: '文生图', desc: '锁定图片意图，按文字描述出图。' },
      { id: 'image-to-image', name: '图生图', desc: '上传参考图后按描述转绘，自动填充参考位。' },
      { id: 'video-gen', name: '视频生成', desc: '锁定视频意图，文生视频或图生视频。' },
      {
        id: 'omni',
        name: '全能',
        desc: '不锁意图 + 图像/视频全模型覆盖 + 编排等通用能力，不知道选哪个就用它。',
      },
    ],
    presetsFoot:
      '建会话时在新建对话框选择；会话中随时点头像旁的预设 chip 切换。技能库可把技能捆绑进预设，成为你的固定工作流。',
    templatesTitle: '模板与斜杠快捷方式',
    templatesBody:
      '在会话里点「固化应用」，成功的生成过程就变成一个可复用模板（输入「/」可看到全部模板）。之后输入 /模板名 + 一句话即可跳过决策直接执行，速度最快。',
    skillsTitle: '技能库',
    skillsBody:
      '技能 = 给 agent 的专业知识文档（Agent Skills 标准）。侧栏底部「技能库」可启停、导入本地技能或粘贴全文；被启用的技能本轮对话即生效。工作台已内置 36 个技能（生图/视频/训练/排障等），默认全部启用。',
    libTitle: '提示词库与素材库（无限画布）',
    libItems: [
      '提示词库：画布笔记工具栏「收藏到提示词库」沉淀常用词；内置 130+ 分词条（画质/风格/光照/构图/色彩/情绪/主体/场景/材质/负面词/模板句式），支持搜索与 JSON 导入。',
      '素材库：左下角面板分「我的素材」（本地上传收藏）与「资产库」两个标签——资产库直接读取出图记录，点击或拖入即可把历史生成图放上画布，无需翻文件夹。',
      '负面提示词与模板句式直接复制到生图输入框；模板句式替换 {花括号} 占位即可成句。',
    ],
    tipsTitle: '效率小贴士',
    tips: [
      '输入框支持多附件（图/视频/音频混合）与本地文件引用，图生图直接拖图进来。',
      '审批模式默认 standard（本地写自动放行）；敏感操作切换 conservative 逐步确认。',
      '会话可导出 JSON/完整包，换机或备份用；归档的会话在侧栏「已归档」里找。',
      '右上「复制调试信息」一键拿到完整决策 spec 与执行快照，报障必备。',
    ],
  },
  en: {
    title: 'AI Workbench Guide',
    scenarioTitle: 'Scenarios · One-click Start',
    scenarioFoot:
      '"Start" creates a session with the matching preset and fills the sample prompt (the image-to-image scenario also attaches a sample reference). Send it and see the result.',
    startBtn: 'Start',
    hoverPlay: 'Hover to preview',
    credit: 'Sample covers & video from Unsplash / Pexels (free licenses, commercial use OK)',
    modesTitle: 'Three Workbench Modes',
    modes: [
      {
        name: 'A · Standalone',
        desc: 'The full workbench from the left menu: chat-driven generation, session management, template factory (solidify a good session into a reusable app), and the artifacts panel. Start here.',
      },
      {
        name: 'C · ComfyUI Sidebar',
        desc: 'A lightweight session dock embedded on the right of ComfyUI: tweak workflows, query models, or run generations without leaving your canvas.',
      },
      {
        name: 'Canvas · AI Dock',
        desc: 'Summoned from the bottom-left of the infinite canvas: send selected images/notes to the agent as references; results land back on the canvas and auto-link to their sources.',
      },
    ],
    presetsTitle: 'Presets (session-level personas)',
    presets: [
      {
        id: 'standard',
        name: 'Standard',
        desc: 'No constraints; the AI decides intent and template freely. Good for exploring.',
      },
      {
        id: 'text-to-image',
        name: 'Text to Image',
        desc: 'Locked to image intent; generate from text descriptions.',
      },
      {
        id: 'image-to-image',
        name: 'Image to Image',
        desc: 'Upload a reference and restyle per description; reference slots auto-fill.',
      },
      {
        id: 'video-gen',
        name: 'Video',
        desc: 'Locked to video intent; text-to-video or image-to-video.',
      },
      {
        id: 'omni',
        name: 'Omni',
        desc: 'No intent lock + full image/video coverage + universal orchestration skills. The safe default.',
      },
    ],
    presetsFoot:
      'Pick one in the new-session dialog; switch anytime via the preset chip next to the avatar. Bundle skills into presets from the Skill Library to build your own workflow.',
    templatesTitle: 'Templates & Slash Shortcuts',
    templatesBody:
      'Press "Solidify app" in a session to turn a successful run into a reusable template (type "/" to see all). Then /template-name + one line skips planning and executes directly — the fastest path.',
    skillsTitle: 'Skill Library',
    skillsBody:
      'A skill = a professional knowledge document for the agent (Agent Skills standard). Enable/disable, import local skills, or paste content from the Skill Library at the sidebar bottom; enabled skills apply from the very next turn. 36 skills ship built-in (image/video/training/troubleshooting), all enabled by default.',
    libTitle: 'Prompt & Asset Libraries (Infinite Canvas)',
    libItems: [
      'Prompt library: save favorites via the note toolbar "Save to prompt library"; 130+ built-in entries (quality/style/lighting/composition/color/mood/subject/scene/material/negatives/templates) with search and JSON import.',
      'Asset library: the bottom-left panel has two tabs — "Mine" (local uploads) and "Gallery" (generation history). Click or drag any gallery image onto the canvas — no folder digging.',
      'Copy negative prompts and template phrases straight into the image input; replace {curly} placeholders to compose instantly.',
    ],
    tipsTitle: 'Efficiency Tips',
    tips: [
      'The composer accepts mixed attachments (image/video/audio) and local file references — just drag images in for image-to-image.',
      'Approval mode defaults to standard (local writes auto-approved); switch to conservative for step-by-step confirmation.',
      'Sessions export to JSON or full bundles for backup/migration; archived sessions live under "Archived" in the sidebar.',
      '"Copy debug info" grabs the full decision spec and execution snapshot — essential for bug reports.',
    ],
  },
}
const c = computed(() => CONTENT[lang.value])
</script>
