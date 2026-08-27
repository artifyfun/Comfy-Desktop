<template>
  <div class="page-container bg-tech-dark">
    <div id="app" class="pb-20 min-h-screen">
      <AppHeader
        :first-nav-to="'/'"
        :first-nav-label="t('appCenter')"
        first-nav-icon="mr-2 fas fa-home"
      />

      <main class="relative px-4 mx-auto mt-4 max-w-7xl sm:px-6 lg:px-8">
        <div class="flex items-center mb-4 space-x-2">
          <div class="w-8 h-8 text-2xl text-tech-blue">
            <i class="fas fa-wand-magic-sparkles"></i>
          </div>
          <h1 class="text-2xl font-bold text-white tech-font">{{ t('workbench') }}</h1>
          <a-tag color="blue">{{ t('workbenchBeta') }}</a-tag>
        </div>

        <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <!-- 左：对话流 -->
          <section
            class="lg:col-span-2 flex flex-col rounded-xl bg-slate-900/60 border border-slate-700 h-[calc(100vh-220px)]"
          >
            <!-- 消息区 -->
            <div ref="messagesEl" class="flex-1 overflow-y-auto p-4 space-y-3">
              <div v-if="messages.length === 0" class="text-center text-slate-400 mt-10">
                <i class="fas fa-comments text-4xl mb-3 opacity-40"></i>
                <p>{{ t('workbenchIntro') }}</p>
              </div>
              <div
                v-for="(m, i) in messages"
                :key="i"
                class="flex"
                :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <div
                  class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words"
                  :class="messageClass(m)"
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
                  <template v-else>{{ m.text }}</template>
                </div>
              </div>
            </div>

            <!-- invalid issues 展示 -->
            <div v-if="pendingIssues.length" class="px-4 pb-2">
              <a-alert type="warning" show-icon class="text-left">
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

            <!-- 输入区 -->
            <div class="border-t border-slate-700 p-3 flex gap-2">
              <a-input
                v-model:value="input"
                :placeholder="t('workbenchInputPlaceholder')"
                :disabled="busy"
                @press-enter="send"
              />
              <a-button type="primary" :loading="busy" @click="send">
                {{ t('send') }}
              </a-button>
            </div>
          </section>

          <!-- 右：产物区 -->
          <section
            class="flex flex-col rounded-xl bg-slate-900/60 border border-slate-700 h-[calc(100vh-220px)]"
          >
            <div class="p-3 border-b border-slate-700 text-white font-semibold">
              <i class="fas fa-photo-film mr-2 text-tech-blue"></i>{{ t('workbenchArtifacts') }}
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
                  <span class="text-xs text-slate-400">{{ a.templateName }}</span>
                </div>
                <div v-if="a.outputs.length" class="text-xs text-slate-300 break-all">
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
                  <a-button size="small" @click="openInComfy(a)" v-if="a.status === 'success'">
                    {{ t('workbenchOpenOutput') }}
                  </a-button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
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
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import AppHeader from '@/views/apps/components/AppHeader.vue'

const { t } = useI18n()
const appStore = useAppStore()
const input = ref('')
const busy = ref(false)
const messages = ref([])
const pendingIssues = ref([])
const artifacts = ref([])
const sessionId = ref('')
let pollTimer = null

const messagesEl = ref(null)
const origin = computed(() => appStore.config?.serverHost || window.location.origin)

// 会话管理：路由 query 带会话 id，页面刷新可续
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()

onMounted(async () => {
  const sid = route.query.session
  if (sid) {
    const res = await fetch(`${origin.value}/api/workbench/session/${sid}`)
    const json = await res.json()
    if (res.ok && json?.success) {
      sessionId.value = sid
      restoreSession(json.data)
      return
    }
  }
  await createSession()
})

function restoreSession(session) {
  messages.value = session.messages.map((m) => ({ ...m }))
  for (const e of session.executions) {
    artifacts.value.unshift({
      promptId: e.promptId,
      templateId: e.templateId,
      templateName: e.templateId,
      status: e.status,
      outputs: e.outputs,
    })
    if (e.status === 'queued' || e.status === 'running') startPoll(e.promptId)
  }
}

async function createSession() {
  const res = await fetch(`${origin.value}/api/workbench/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '工作台' }),
  })
  const json = await res.json()
  sessionId.value = json.data.id
  router.replace({ query: { session: sessionId.value } })
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

async function send() {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  busy.value = true
  pendingIssues.value = []
  messages.value.push({ role: 'user', kind: 'chat', text })
  messages.value.push({ role: 'agent', kind: 'progress', text: t('workbenchDeciding') })
  scrollToBottom()
  try {
    const res = await fetch(`${origin.value}/api/workbench/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId.value, input: text }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    // SSE 流
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
  // 移除 deciding 占位
  const last = messages.value[messages.value.length - 1]
  if (last && last.kind === 'progress' && last.text === t('workbenchDeciding')) {
    messages.value.pop()
  }
  if (event === 'reply') {
    messages.value.push({ role: 'agent', kind: 'chat', text: data.reply || '' })
  } else if (event === 'plan') {
    messages.value.push({ role: 'agent', kind: 'card', text: '', plan: data.plan })
  } else if (event === 'stage') {
    messages.value.push({ role: 'agent', kind: 'progress', text: stageText(data.stage) })
  } else if (event === 'submitted') {
    const lastProgress = messages.value[messages.value.length - 1]
    if (lastProgress && lastProgress.kind === 'progress') messages.value.pop()
    messages.value.push({ role: 'agent', kind: 'chat', text: t('workbenchSubmitted') })
    artifacts.value.unshift({
      promptId: data.promptId,
      templateId: data.templateId,
      templateName: data.templateId,
      status: 'running',
      outputs: [],
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
        if (r.status === 'success' && r.outputs) artifact.outputs = extractFiles(r.outputs)
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
      }
    } catch {
      /* 下轮重试 */
    }
  }
  pollTimers.set(promptId, setInterval(poll, 3000))
}

const pollTimers = new Map()
function stopPoll(promptId) {
  const timer = pollTimers.get(promptId)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(promptId)
  }
}

function extractFiles(outputs) {
  const files = []
  for (const v of Object.values(outputs || {})) {
    const o = v || {}
    for (const key of ['images', 'gifs']) {
      for (const it of o[key] ?? []) if (it.filename) files.push(it.filename)
    }
  }
  return files
}

// 固化
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
    messages.value.push({ role: 'agent', kind: 'error', text: e.message })
  } finally {
    publishing.value = false
  }
}

function openInComfy(artifact) {
  const url = `${appStore.config?.comfyHost || ''}`
  if (url) window.open(url, '_blank')
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  })
}

onBeforeUnmount(() => {
  for (const timer of pollTimers.values()) clearInterval(timer)
  pollTimers.clear()
})
</script>

<style scoped>
.bg-tech-blue\/90 {
  background-color: rgba(59, 130, 246, 0.9);
}
</style>
