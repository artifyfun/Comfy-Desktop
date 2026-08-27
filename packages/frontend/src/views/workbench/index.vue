<template>
  <div class="page-container bg-tech-dark">
    <div id="app" class="pb-20 min-h-screen flex flex-col">
      <AppHeader
        :first-nav-to="'/'"
        :first-nav-label="t('appCenter')"
        first-nav-icon="mr-2 fas fa-home"
      />

      <div
        class="flex flex-1 min-h-0 px-4 mx-auto mt-2 w-full max-w-[1600px] sm:px-6 lg:px-8 gap-4"
      >
        <!-- 左：会话侧栏 -->
        <SessionSidebar
          :sessions="sidebarSessions"
          :current-id="sessionId"
          :collapsed="sidebarCollapsed"
          :show-archived="showArchived"
          @select="selectSession"
          @new-session="newDialogOpen = true"
          @collapse="sidebarCollapsed = !sidebarCollapsed"
          @rename="onRename"
          @archive="(s) => setArchived(s, true)"
          @unarchive="(s) => setArchived(s, false)"
          @delete="onDelete"
          @update:show-archived="(v) => (showArchived = v)"
          @manage-presets="presetMgrOpen = true"
          @show-env="showEnvDialog"
        />

        <!-- 中：会话区 -->
        <section
          class="flex-1 min-w-0 flex flex-col rounded-xl bg-slate-900/60 border border-slate-700 h-[calc(100vh-160px)]"
        >
          <!-- 会话头 -->
          <div class="flex items-center gap-2 px-4 h-12 border-b border-slate-700 shrink-0">
            <!-- 预设 chip：点击切换（dsh preset 模式） -->
            <a-dropdown :trigger="['click']">
              <button
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition"
                :class="
                  sessionPreset
                    ? 'border-tech-blue/60 bg-tech-blue/10 text-tech-blue'
                    : 'border-slate-600 text-slate-300 hover:border-slate-400'
                "
                :title="t('workbenchPresetSwitch')"
              >
                <i :class="sessionPreset ? presetIcon(sessionPreset) : 'fas fa-bolt'"></i>
                {{ sessionPreset ? presetName(sessionPreset) : t('workbenchPresetPick') }}
                <i class="fas fa-chevron-down text-[9px] opacity-60"></i>
              </button>
              <template #overlay>
                <a-menu @click="onPresetMenu">
                  <a-menu-item v-for="p in sortedPresets" :key="p.id">
                    <span class="flex items-center gap-2">
                      <i :class="presetIcon(p)" class="w-4 text-tech-blue"></i>
                      <span>{{ presetName(p) }}</span>
                      <i
                        v-if="currentSession?.presetId === p.id"
                        class="fas fa-check text-tech-blue ml-auto"
                      ></i>
                    </span>
                    <div class="text-[11px] text-slate-400 whitespace-normal leading-snug mt-0.5">
                      {{ p.description?.[lang] || p.description?.zh }}
                    </div>
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
            <div class="flex-1 text-white text-sm truncate font-medium">
              {{ currentSession?.title || t('workbench') }}
            </div>
            <a-button size="small" @click="panelOpen = !panelOpen">
              <i class="fas fa-table-columns"></i>
            </a-button>
          </div>

          <!-- 对话流（含执行卡内联） -->
          <div ref="messagesEl" class="flex-1 overflow-y-auto p-4 space-y-3">
            <div v-if="messages.length === 0" class="text-center text-slate-400 mt-10">
              <i class="fas fa-wand-magic-sparkles text-4xl mb-3 opacity-40"></i>
              <p>{{ t('workbenchIntro') }}</p>
            </div>
            <div
              v-for="(m, i) in messages"
              :key="i"
              class="flex"
              :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div class="max-w-[85%] space-y-1">
                <!-- 附件缩略图（用户消息） -->
                <div v-if="m.attachments?.length" class="flex gap-1.5 flex-wrap justify-end">
                  <div
                    v-for="(a, j) in m.attachments"
                    :key="j"
                    class="w-12 h-12 rounded bg-slate-800 border border-slate-600 flex items-center justify-center overflow-hidden"
                  >
                    <img
                      v-if="a.kind === 'image' && a._preview"
                      :src="a._preview"
                      class="w-full h-full object-cover"
                    />
                    <i v-else :class="kindIcon(a.kind)" class="text-slate-400"></i>
                  </div>
                </div>
                <!-- 产物缩略图（artifact 消息内联，点击 lightbox） -->
                <div
                  v-if="m.kind === 'artifact' && m.outputFiles?.length"
                  class="flex gap-2 flex-wrap"
                >
                  <div
                    v-for="(f, j) in m.outputFiles"
                    :key="j"
                    class="w-24 h-24 rounded-lg overflow-hidden bg-slate-800 border border-slate-600 cursor-zoom-in hover:border-tech-blue transition flex items-center justify-center"
                    @click="lightboxFile = f"
                  >
                    <img :src="viewUrl(f)" class="w-full h-full object-cover" loading="lazy" />
                  </div>
                </div>
                <div
                  class="rounded-lg px-3 py-2 text-sm break-words"
                  :class="[
                    messageClass(m),
                    m.kind === 'chat' || m.kind === 'error' ? '' : 'whitespace-pre-wrap',
                  ]"
                >
                  <template v-if="m.kind === 'card' && m.plan">
                    <div class="font-semibold mb-1">
                      <i class="fas fa-diagram-project mr-1"></i>{{ t('workbenchPlan') }}
                    </div>
                    <div class="text-xs opacity-80 mb-2">{{ m.plan.reason }}</div>
                    <div class="text-xs">{{ cardText(m.plan) }}</div>
                  </template>
                  <template v-else-if="m.kind === 'progress'">
                    <a-spin size="small" />
                    <span class="ml-2">{{ m.text }}</span>
                  </template>
                  <!-- codex 工具条目折叠行（执行中 spinner，完成后可展开详情） -->
                  <template v-else-if="m.kind === 'tool_item' && m.toolItem">
                    <div class="flex items-center gap-2 min-w-0" @click.stop="toggleToolItem(m)">
                      <a-spin v-if="toolItemRunning(m.toolItem)" size="small" />
                      <i
                        v-else
                        :class="`fas ${toolItemSummary(m.toolItem).icon} text-tech-cyan`"
                      ></i>
                      <span class="font-mono text-xs truncate flex-1">{{
                        toolItemSummary(m.toolItem).label
                      }}</span>
                      <i
                        v-if="toolItemDetail(m.toolItem)"
                        :class="`fas fa-chevron-${expandedToolIds.has(m.toolItem.id) ? 'down' : 'right'} text-[10px] opacity-60`"
                      ></i>
                    </div>
                    <pre
                      v-if="expandedToolIds.has(m.toolItem.id) && toolItemDetail(m.toolItem)"
                      class="mt-1.5 max-h-48 overflow-y-auto text-[11px] leading-relaxed rounded bg-black/40 border border-slate-700 p-2 whitespace-pre-wrap break-all text-slate-300 font-mono"
                      >{{ toolItemDetail(m.toolItem) }}</pre
                    >
                  </template>
                  <!-- agent 文本走 markdown（dsh 同款 marked+DOMPurify）；用户消息保持纯文本 -->
                  <WbMarkdown
                    v-else-if="(m.kind === 'chat' || m.kind === 'error') && m.role === 'agent'"
                    :source="m.text"
                  />
                  <template v-else>{{ m.text }}</template>
                </div>
              </div>
            </div>
          </div>

          <!-- invalid issues -->
          <div v-if="pendingIssues.length" class="px-4 pb-2">
            <a-alert type="warning" show-icon>
              <template #message>{{ t('workbenchPlanInvalid') }}</template>
              <template #description>
                <ul class="list-disc pl-4 text-xs">
                  <li v-for="(issue, i) in pendingIssues" :key="i">
                    {{ issue.field }}: {{ issue.message }}
                  </li>
                </ul>
              </template>
            </a-alert>
          </div>

          <!-- 富输入框 -->
          <Composer
            ref="composerEl"
            v-model="input"
            :busy="busy"
            :uploading="uploading"
            :attachments="draftAttachments"
            :skills="skills"
            :model-override="modelOverride"
            @send="send"
            @upload-files="uploadFiles"
            @remove-attachment="removeAttachment"
            @update:model-override="saveModelOverride"
          />
        </section>

        <!-- 右：产物面板（可折叠） -->
        <section
          v-if="panelOpen"
          class="w-72 shrink-0 flex flex-col rounded-xl bg-slate-900/60 border border-slate-700 h-[calc(100vh-160px)]"
        >
          <div
            class="p-3 border-b border-slate-700 text-white font-semibold flex items-center justify-between"
          >
            <span
              ><i class="fas fa-photo-film mr-2 text-tech-blue"></i
              >{{ t('workbenchArtifacts') }}</span
            >
          </div>
          <div class="flex-1 overflow-y-auto p-3 space-y-3">
            <div v-if="artifacts.length === 0" class="text-center text-slate-400 mt-8 text-sm">
              {{ t('workbenchNoArtifacts') }}
            </div>
            <div
              v-for="(a, i) in artifacts"
              :key="i"
              class="rounded-lg border border-slate-700 bg-slate-800/50 p-2"
            >
              <div class="flex items-center justify-between mb-1">
                <a-tag
                  :color="
                    a.status === 'success' ? 'green' : a.status === 'error' ? 'red' : 'processing'
                  "
                >
                  {{ a.status }}
                </a-tag>
                <span class="text-xs text-slate-400 truncate max-w-[140px]">{{
                  a.templateName
                }}</span>
              </div>
              <!-- 产物缩略图网格（ComfyUI /view 直出，点击 lightbox） -->
              <div v-if="a.files?.length" class="grid grid-cols-3 gap-1 mb-1">
                <div
                  v-for="(f, j) in a.files"
                  :key="j"
                  class="aspect-square rounded overflow-hidden bg-slate-900 border border-slate-600 cursor-zoom-in hover:border-tech-blue transition"
                  @click="lightboxFile = f"
                >
                  <img :src="viewUrl(f)" class="w-full h-full object-cover" loading="lazy" />
                </div>
              </div>
              <div v-else-if="a.outputs.length" class="text-xs text-slate-300 break-all">
                {{ a.outputs.join(' · ') }}
              </div>
              <div class="mt-2 flex gap-2">
                <a-button
                  v-if="a.status === 'success'"
                  size="small"
                  type="primary"
                  @click="openPublish(a)"
                >
                  <i class="fas fa-bolt mr-1"></i>{{ t('workbenchPublish') }}
                </a-button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 新建会话（预设 chip） -->
    <NewSessionDialog
      v-model:open="newDialogOpen"
      :presets="presets"
      :default-preset-id="defaultPresetId"
      @create="createSession"
    />

    <!-- 技能/预设管理 -->
    <PresetManager
      v-model:open="presetMgrOpen"
      :presets="presets"
      :default-id="defaultPresetId"
      @changed="loadPresets"
    />

    <!-- 工作台能力/环境说明（自我认知可视化） -->
    <a-modal v-model:open="envOpen" :title="t('workbenchEnvInfo')" :footer="null" width="560px">
      <div v-if="envLoading" class="py-8 text-center"><a-spin /></div>
      <div v-else-if="envSnapshot" class="space-y-3 py-2">
        <div>
          <div class="text-xs text-slate-400 mb-1">{{ t('workbenchEnvSkills') }}</div>
          <div class="flex flex-wrap gap-1.5">
            <a-tag v-for="n in envSnapshot.appNames" :key="n" color="blue">{{ n }}</a-tag>
            <span v-if="!envSnapshot.appNames.length" class="text-xs text-slate-500">—</span>
          </div>
        </div>
        <div>
          <div class="text-xs text-slate-400 mb-1">{{ t('workbenchEnvModels') }}</div>
          <div v-for="(names, type) in envSnapshot.modelsByType" :key="type" class="text-xs mb-1">
            <span class="text-tech-cyan font-mono">{{ type }}</span
            >：
            <span class="text-slate-300"
              >{{ names.slice(0, 12).join('、')
              }}{{ names.length > 12 ? ` 等 ${names.length} 个` : '' }}</span
            >
          </div>
          <div v-if="!Object.keys(envSnapshot.modelsByType).length" class="text-xs text-slate-500">
            —（未配置 modelsDirs 或目录为空）
          </div>
        </div>
        <div class="flex gap-4 text-xs">
          <span class="text-slate-400"
            >{{ t('workbenchEnvVram') }}:
            <b class="text-white">{{
              envSnapshot.vramGb ? `约 ${Math.round(envSnapshot.vramGb)}GB` : '—'
            }}</b></span
          >
          <span class="text-slate-400"
            >{{ t('workbenchEnvNodes') }}:
            <b class="text-white">{{ envSnapshot.customNodes.length }}</b></span
          >
        </div>
        <a-collapse ghost>
          <a-collapse-panel
            key="nodes"
            :header="`${t('workbenchEnvNodes')} (${envSnapshot.customNodes.length})`"
          >
            <div class="text-xs text-slate-300 break-all leading-relaxed">
              {{ envSnapshot.customNodes.join('、') || '—' }}
            </div>
          </a-collapse-panel>
        </a-collapse>
        <p class="text-xs text-slate-500 leading-relaxed border-t border-slate-700 pt-2">
          {{ t('workbenchEnvHint') }}
        </p>
      </div>
    </a-modal>

    <!-- Lightbox：产物大图/视频预览 -->
    <div
      v-if="lightboxFile"
      class="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center"
      @click="lightboxFile = null"
    >
      <video
        v-if="isVideoFile(lightboxFile)"
        :src="viewUrl(lightboxFile)"
        controls
        autoplay
        class="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
        @click.stop
      ></video>
      <img
        v-else
        :src="viewUrl(lightboxFile)"
        class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
      <button
        class="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white text-xl hover:bg-white/20 flex items-center justify-center"
        @click.stop="lightboxFile = null"
      >
        <i class="fas fa-xmark"></i>
      </button>
    </div>

    <!-- 固化弹窗 -->
    <a-modal
      v-model:open="publishOpen"
      :title="t('workbenchPublishTitle')"
      @ok="doPublish"
      :ok-text="t('confirm')"
      :cancel-text="t('cancel')"
      :ok-button-props="{ loading: publishing }"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('appName')">
          <a-input
            v-model:value="publishName"
            :placeholder="t('workbenchPublishNamePlaceholder')"
            class="wb-tech-input"
          />
        </a-form-item>
        <a-form-item :label="t('workbenchPublishUi')">
          <a-switch v-model:checked="publishBuildUi" />
          <span class="ml-2 text-xs text-slate-400">{{ t('workbenchPublishUiHint') }}</span>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import AppHeader from '@/views/apps/components/AppHeader.vue'
import SessionSidebar from './components/SessionSidebar.vue'
import WbMarkdown from './components/WbMarkdown.vue'
import Composer from './components/Composer.vue'
import NewSessionDialog from './components/NewSessionDialog.vue'
import PresetManager from './components/PresetManager.vue'

const { t, getCurrentLanguage } = useI18n()
const appStore = useAppStore()
const route = useRoute()
const router = useRouter()

const origin = computed(() => appStore.config?.serverHost || window.location.origin)
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

// ---------- 会话状态 ----------
const sessions = ref([])
const sessionId = ref('')
const messages = ref([])
const artifacts = ref([])
const pendingIssues = ref([])
const input = ref('')
const busy = ref(false)
const uploading = ref(false)
const draftAttachments = ref([])
const skills = ref([])
const presets = ref([])
const defaultPresetId = ref('standard')
const modelOverride = ref({})
const sidebarCollapsed = ref(false)
const showArchived = ref(false)
const panelOpen = ref(true)
const messagesEl = ref(null)
const composerEl = ref(null)
const pollTimers = new Map()
const newDialogOpen = ref(false)
const presetMgrOpen = ref(false)

const currentSession = computed(() => sessions.value.find((s) => s.id === sessionId.value))
const sessionPreset = computed(() =>
  currentSession.value?.presetId
    ? presets.value.find((p) => p.id === currentSession.value.presetId)
    : null,
)
const sidebarSessions = computed(() =>
  sessions.value.map((s) => ({
    ...s,
    _running: (s.executions ?? []).some((e) => e.status === 'queued' || e.status === 'running'),
  })),
)

// ---------- 初始化 ----------
onMounted(async () => {
  await Promise.all([loadSessions(), loadPresets(), loadSkills()])
  const sid = route.query.session
  if (sid && sessions.value.some((s) => s.id === sid)) {
    await selectSession({ id: sid })
  } else {
    await createSession({ presetId: defaultPresetId.value })
  }
  document.addEventListener('keydown', onGlobalKey)
})

onBeforeUnmount(() => {
  for (const timer of pollTimers.values()) clearInterval(timer)
  pollTimers.clear()
  document.removeEventListener('keydown', onGlobalKey)
})

function onGlobalKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault()
    newDialogOpen.value = true
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    // 聚焦输入框（对话主场景）
    e.preventDefault()
    composerEl.value?.querySelector('textarea')?.focus()
  }
}

async function loadSessions() {
  const res = await fetch(`${origin.value}/api/workbench/sessions?archived=${showArchived.value}`)
  const json = await res.json()
  sessions.value = json?.data ?? []
}

async function loadPresets() {
  const res = await fetch(`${origin.value}/api/workbench/presets`)
  const json = await res.json()
  presets.value = json?.data?.presets ?? []
  defaultPresetId.value = json?.data?.default ?? 'standard'
}

async function loadSkills() {
  const res = await fetch(`${origin.value}/api/workbench/skills`)
  const json = await res.json()
  skills.value = json?.data ?? []
}

async function selectSession(s) {
  sessionId.value = s.id
  toolItemIndex.clear() // 条目索引是 per-render 的，切会话必须清（防 upsert 错位）
  router.replace({ query: { session: s.id } })
  const res = await fetch(`${origin.value}/api/workbench/session/${s.id}`)
  const json = await res.json()
  if (!res.ok || !json?.success) return
  const session = json.data
  messages.value = session.messages ?? []
  artifacts.value = [...(session.executions ?? [])].reverse().map((e) => ({
    promptId: e.promptId,
    templateId: e.templateId,
    templateName: e.templateId,
    status: e.status,
    outputs: (e.outputs ?? []).map((f) => (typeof f === 'string' ? f : f.filename)),
    // v2 outputs 为完整引用对象；旧数据字符串只有 filename（lightbox 降级直开）
    files: (e.outputs ?? []).filter((f) => typeof f === 'object'),
  }))
  modelOverride.value = session.modelOverride ?? {}
  pendingIssues.value = []
  for (const e of session.executions ?? []) {
    if (e.status === 'queued' || e.status === 'running') startPoll(e.promptId)
  }
  scrollToBottom()
}

async function createSession({ presetId, title }) {
  const res = await fetch(`${origin.value}/api/workbench/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetId, title }),
  })
  const json = await res.json()
  await loadSessions()
  await selectSession({ id: json.data.id })
}

async function onRename({ id, title }) {
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title }),
  })
  await loadSessions()
}

async function setArchived(s, archived) {
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, archived }),
  })
  await loadSessions()
  if (sessionId.value === s.id && archived) {
    const first = sessions.value.find((x) => !x.archived)
    if (first) await selectSession(first)
  }
}

async function onDelete(s) {
  await fetch(`${origin.value}/api/workbench/sessions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id }),
  })
  await loadSessions()
  if (sessionId.value === s.id) {
    const first = sessions.value[0]
    if (first) await selectSession(first)
    else await createSession({})
  }
}

async function saveModelOverride(v) {
  modelOverride.value = v
  if (!sessionId.value) return
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId.value, modelOverride: v }),
  })
}

// ---------- 附件 ----------
async function uploadFiles(files) {
  uploading.value = true
  for (const f of files) {
    const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null
    const kind = f.type.startsWith('image/')
      ? 'image'
      : f.type.startsWith('video/')
        ? 'video'
        : f.type.startsWith('audio/')
          ? 'audio'
          : 'file'
    draftAttachments.value.push({
      kind,
      filename: f.name,
      size: f.size,
      mime: f.type,
      uploading: true,
      _preview: preview,
    })
    const idx = draftAttachments.value.length - 1
    try {
      const form = new FormData()
      form.append('file', f)
      const res = await fetch(`${origin.value}/api/workbench/upload`, {
        method: 'POST',
        body: form,
      })
      const json = await res.json()
      if (!res.ok || !json?.success) throw new Error(json?.message || 'upload failed')
      Object.assign(draftAttachments.value[idx], json.data, { uploading: false })
    } catch (e) {
      message.error(`${f.name}: ${e.message}`)
      draftAttachments.value.splice(idx, 1)
    }
  }
  uploading.value = false
}

function removeAttachment(i) {
  const a = draftAttachments.value[i]
  if (a?._preview) URL.revokeObjectURL(a._preview)
  draftAttachments.value.splice(i, 1)
}

function kindIcon(kind) {
  if (kind === 'video') return 'fas fa-film'
  if (kind === 'audio') return 'fas fa-music'
  if (kind === 'file') return 'fas fa-file'
  return 'fas fa-image'
}

// ---------- 发送 ----------
async function send() {
  const text = input.value.trim()
  const readyAttachments = draftAttachments.value.filter((a) => !a.uploading)
  // 文本或已上传附件至少其一即可发送（dsh 语义：附件可作为唯一输入）
  if ((!text && readyAttachments.length === 0) || busy.value) return
  const attachments = readyAttachments.map((a) => ({
    name: a.name,
    subfolder: a.subfolder,
    type: a.type,
    kind: a.kind,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
  }))
  input.value = ''
  for (const a of draftAttachments.value) if (a._preview) URL.revokeObjectURL(a._preview)
  draftAttachments.value = []
  busy.value = true
  pendingIssues.value = []
  messages.value.push({
    role: 'user',
    kind: 'chat',
    text,
    attachments: attachments.length ? attachments : undefined,
  })
  messages.value.push({ role: 'agent', kind: 'progress', text: t('workbenchDeciding') })
  scrollToBottom()
  try {
    const res = await fetch(`${origin.value}/api/workbench/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId.value, input: text, attachments }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const part of parts) handleSse(part)
    }
  } catch (e) {
    messages.value.push({ role: 'agent', kind: 'error', text: e.message })
  } finally {
    busy.value = false
    scrollToBottom()
  }
}

// ---------- codex 条目流转写（抄 codex app-server/dsh transcript：
// item.id → 消息行索引，started 占行，updated/completed 原位 upsert） ----------
const toolItemIndex = new Map()

function toolItemSummary(item) {
  switch (item.type) {
    case 'command_execution':
      return { icon: 'fa-terminal', label: item.command }
    case 'file_change':
      return {
        icon: 'fa-file-pen',
        label: (item.changes || []).map((c) => c.path).join(', ') || 'file change',
      }
    case 'mcp_tool_call':
      return { icon: 'fa-plug', label: `${item.server}/${item.tool}` }
    case 'web_search':
      return { icon: 'fa-magnifying-glass', label: item.query || 'web search' }
    case 'reasoning':
      return { icon: 'fa-brain', label: (item.text || '').slice(0, 80) }
    case 'todo_list':
      return { icon: 'fa-list-check', label: 'todo' }
    case 'error':
      return { icon: 'fa-triangle-exclamation', label: item.message || 'error' }
    default:
      return { icon: 'fa-circle-dot', label: item.type }
  }
}

const expandedToolIds = reactive(new Set())

function toggleToolItem(m) {
  const id = m.toolItem?.id
  if (!id || !toolItemDetail(m.toolItem)) return
  if (expandedToolIds.has(id)) expandedToolIds.delete(id)
  else expandedToolIds.add(id)
}

function toolItemRunning(item) {
  // 各 item 的 in-flight 状态字段统一收口
  return (
    item.status === 'in_progress' ||
    item.status === 'inProgress' ||
    (item.type === 'command_execution' && item.exit_code === undefined) ||
    false
  )
}

function toolItemDetail(item) {
  switch (item.type) {
    case 'command_execution':
      return item.aggregated_output || null
    case 'file_change':
      return (item.changes || []).map((c) => `${c.kind || 'update'}: ${c.path}`).join('\n') || null
    case 'mcp_tool_call':
      return item.result
        ? JSON.stringify(item.result, null, 1)
        : JSON.stringify(item.arguments ?? {}, null, 1)
    case 'reasoning':
      return item.text && item.text.length > 80 ? item.text : null
    default:
      return null
  }
}

function handleThreadItem(evt) {
  if (!evt || typeof evt !== 'object') return
  const phase = evt.type // started | updated | completed
  const item = evt.item
  if (!item || !item.id) return
  if (phase === 'started' && !toolItemIndex.has(item.id)) {
    messages.value.push({ role: 'agent', kind: 'tool_item', text: '', toolItem: item })
    toolItemIndex.set(item.id, messages.value.length - 1)
    return
  }
  const idx = toolItemIndex.get(item.id)
  if (idx === undefined) {
    // 错过 started（如重连）——直接补一行
    messages.value.push({ role: 'agent', kind: 'tool_item', text: '', toolItem: item })
    toolItemIndex.set(item.id, messages.value.length - 1)
    return
  }
  // 原位更新（Vue3 响应式数组元素替换）
  messages.value[idx] = { ...messages.value[idx], toolItem: item }
}

function handleSse(chunk) {
  let event = 'message'
  let data = null
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6))
      } catch {
        data = { raw: line.slice(6) }
      }
    }
  }
  const last = messages.value[messages.value.length - 1]
  if (last && last.kind === 'progress' && last.text === t('workbenchDeciding')) {
    messages.value.pop()
  }
  if (event === 'reply') {
    messages.value.push({ role: 'agent', kind: 'chat', text: data.reply || '' })
  } else if (event === 'item') {
    handleThreadItem(data.event)
  } else if (event === 'plan') {
    messages.value.push({ role: 'agent', kind: 'card', text: '', plan: data.plan })
  } else if (event === 'stage') {
    messages.value.push({ role: 'agent', kind: 'progress', text: stageText(data.stage) })
  } else if (event === 'submitted') {
    const lp = messages.value[messages.value.length - 1]
    if (lp && lp.kind === 'progress') messages.value.pop()
    messages.value.push({ role: 'agent', kind: 'chat', text: t('workbenchSubmitted') })
    artifacts.value.unshift({
      promptId: data.promptId,
      templateId: data.templateId,
      templateName: data.templateId,
      status: 'running',
      outputs: [],
      files: [],
    })
    startPoll(data.promptId)
  } else if (event === 'invalid') {
    pendingIssues.value = data.issues ?? []
    messages.value.push({
      role: 'agent',
      kind: 'error',
      text: t('workbenchPlanInvalid') + ': ' + (data.issues ?? []).map((i) => i.message).join('；'),
    })
  } else if (event === 'error') {
    messages.value.push({ role: 'agent', kind: 'error', text: data.message || 'error' })
  } else if (event === 'done') {
    // 会话摘要 → 侧栏刷新（标题可能被自动生成更新）
    if (data.session) {
      const s = sessions.value.find((x) => x.id === data.session.id)
      if (s) {
        s.title = data.session.title
        s.updatedAt = data.session.updatedAt
      } else {
        loadSessions()
      }
    }
  }
}

function stageText(stage) {
  const map = {
    deciding: t('workbenchDeciding'),
    validating: t('workbenchValidating'),
    executing: t('workbenchExecuting'),
  }
  return map[stage] ?? stage
}

function startPoll(promptId) {
  const poll = async () => {
    try {
      const res = await fetch(`${origin.value}/api/workbench/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.value, promptId }),
      })
      const json = await res.json()
      const r = json?.data
      if (!r) return
      const artifact = artifacts.value.find((a) => a.promptId === promptId)
      if (artifact) {
        artifact.status = r.status
        if (r.status === 'success' && r.outputs) {
          artifact.outputs = extractFiles(r.outputs).map((f) => f.filename)
          artifact.files = extractFiles(r.outputs)
        }
      }
      if (r.status === 'success' || r.status === 'error') {
        messages.value.push({
          role: 'agent',
          kind: r.status === 'success' ? 'chat' : 'error',
          text:
            r.status === 'success'
              ? t('workbenchDone')
              : `${t('workbenchFailed')}: ${(r.error || '').slice(0, 300)}`,
        })
        scrollToBottom()
        stopPoll(promptId)
        loadSessions().then(() => {
          const s = sessions.value.find((x) => x.id === sessionId.value)
          const exec = s?.executions?.find((e) => e.promptId === promptId)
          if (exec) {
            const art = artifacts.value.find((a) => a.promptId === promptId)
            if (art) {
              art.outputs = (exec.outputs ?? []).map((f) =>
                typeof f === 'string' ? f : f.filename,
              )
              art.files = (exec.outputs ?? []).filter((f) => typeof f === 'object')
            }
          }
        })
      }
    } catch {
      /* 下轮重试 */
    }
  }
  pollTimers.set(promptId, setInterval(poll, 3000))
}

function stopPoll(promptId) {
  const timer = pollTimers.get(promptId)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(promptId)
  }
}

function extractFiles(outputs) {
  // v2：保留完整引用（filename+subfolder+type），/view 直出缩略图
  const files = []
  for (const v of Object.values(outputs || {})) {
    const o = v || {}
    for (const key of ['images', 'gifs']) {
      for (const it of o[key] ?? []) {
        if (it.filename)
          files.push({ filename: it.filename, subfolder: it.subfolder, type: it.type })
      }
    }
  }
  return files
}

const comfyOrigin = computed(() => appStore.config?.comfyHost || 'http://127.0.0.1:8188')
const lightboxFile = ref(null)

function viewUrl(f) {
  return `${comfyOrigin.value}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`
}

function isVideoFile(f) {
  return /\.(mp4|webm|mov|gif)$/i.test(f?.filename ?? '')
}

// ---------- 固化 ----------
const publishOpen = ref(false)
const publishName = ref('')
const publishBuildUi = ref(true)
const publishing = ref(false)
const publishTarget = ref(null)

function openPublish(artifact) {
  publishTarget.value = artifact
  publishName.value = `App ${new Date().toLocaleString()}`
  publishOpen.value = true
}

async function doPublish() {
  if (!publishTarget.value || !publishName.value.trim()) return
  publishing.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId.value,
        promptId: publishTarget.value.promptId,
        name: publishName.value.trim(),
        buildUi: publishBuildUi.value,
      }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'publish failed')
    publishOpen.value = false
    messages.value.push({ role: 'agent', kind: 'chat', text: t('workbenchPublished') })
    router.push('/')
  } catch (e) {
    message.error(e.message)
  } finally {
    publishing.value = false
  }
}

function presetName(p) {
  return p?.name?.[lang.value] || p?.name?.zh || p?.id
}

// ---------- 能力/环境说明（自我认知可视化） ----------
const envOpen = ref(false)
const envLoading = ref(false)
const envSnapshot = ref(null)

async function showEnvDialog() {
  envOpen.value = true
  envLoading.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/env`)
    const json = await res.json()
    envSnapshot.value = json?.data ?? null
  } finally {
    envLoading.value = false
  }
}

// dsh order 语义：预设列表按 order 升序
const sortedPresets = computed(() =>
  [...presets.value].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
)

function presetIcon(p) {
  if (p?.intentHint === 'video') return 'fas fa-film'
  if (p?.intentHint === 'image') return 'fas fa-image'
  return 'fas fa-bolt'
}

// 预设点击切换（dsh 模式）：会话级 presetId 立即生效
async function onPresetMenu({ key }) {
  if (!sessionId.value || sessionId.value === key) return
  await fetch(`${origin.value}/api/workbench/sessions/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sessionId.value, presetId: key }),
  })
  await loadSessions()
  // 本地会话对象同步（selectSession 会重新拉详情）
  const s = sessions.value.find((x) => x.id === sessionId.value)
  if (s) Object.assign(currentSession.value ?? {}, { presetId: key })
}

function messageClass(m) {
  if (m.role === 'user') return 'bg-tech-blue/90 text-white'
  if (m.kind === 'error') return 'bg-red-900/60 text-red-200'
  if (m.kind === 'card') return 'bg-slate-800 text-slate-200 border border-slate-600'
  return 'bg-slate-800/70 text-slate-200'
}

function cardText(plan) {
  if (!plan) return ''
  const p = plan.params ?? {}
  const ps = Object.entries(p)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join('，')
  return `${plan.intent} · ${plan.templateId ?? ''}${ps ? ' · ' + ps : ''}`
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

watch(showArchived, loadSessions)
</script>

<style scoped>
.bg-tech-blue\/90 {
  background-color: rgba(59, 130, 246, 0.9);
}
</style>

<style>
/* 工作台全局小样式（modal 传送 body，需非 scoped） */
@import './workbench.css';
</style>
