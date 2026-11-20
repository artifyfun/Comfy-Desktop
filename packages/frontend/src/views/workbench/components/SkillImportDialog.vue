<template>
  <a-modal
    :open="open"
    :title="t('workbenchSkillImport')"
    width="720px"
    :ok-text="t('confirm')"
    :ok-button-props="{ loading: importing }"
    :cancel-text="t('cancel')"
    @ok="doImport"
    @cancel="close"
  >
    <div class="space-y-3">
      <a-tabs v-model:activeKey="activeTab" size="small">
        <!-- Tab ① 本机扫描 -->
        <a-tab-pane key="scan" :tab="t('workbenchSkillTabScan')">
          <div class="flex items-center justify-between mb-2">
            <a-tag color="cyan" class="!m-0">recommended</a-tag>
            <div class="flex gap-1">
              <a-button size="small" type="text" :disabled="!sources.length" @click="selectAllScan">
                <i class="fas fa-check-double mr-1"></i>{{ t('workbenchSkillSelectAll') }}
              </a-button>
              <a-button size="small" type="text" :disabled="!sources.length" @click="invertScan">
                {{ t('workbenchSkillInvert') }}
              </a-button>
              <a-button
                size="small"
                type="text"
                :disabled="!scanPicks.size"
                @click="scanPicks.clear()"
              >
                {{ t('workbenchSkillClear') }}
              </a-button>
              <a-button size="small" type="text" :loading="scanning" @click="scan">
                <i class="fas fa-rotate"></i>
              </a-button>
            </div>
          </div>
          <div
            v-if="!scanning && sources.length === 0"
            class="text-xs text-[var(--wb-text-3)] px-2 py-2 rounded"
            style="border: 1px dashed var(--wb-stroke)"
          >
            {{ t('workbenchSkillImportScanEmpty') }}
          </div>
          <div v-for="src in sources" :key="src.path" class="mb-2">
            <div class="text-[11px] text-[var(--wb-text-3)] mb-0.5 font-mono">
              {{ src.label }} — {{ src.path }} ({{ src.skills.length }})
            </div>
            <div class="space-y-0.5 max-h-64 overflow-y-auto pl-2">
              <label
                v-for="d in src.skills"
                :key="src.label + d.name"
                class="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--wb-surface-hover)] cursor-pointer"
              >
                <input
                  type="checkbox"
                  class="wb-tech-check"
                  :checked="scanPicks.has(scanKey(src, d))"
                  @change="toggleScanPick(src, d, $event)"
                />
                <span class="text-sm text-white font-mono">{{ d.name }}</span>
                <span class="text-[11px] text-[var(--wb-text-2)] truncate flex-1">{{
                  d.description
                }}</span>
                <span v-if="d.alreadyImported" class="text-[10px] text-[var(--wb-text-3)]">{{
                  t('workbenchSkillImportedTag')
                }}</span>
                <span class="text-[10px] text-[var(--wb-text-3)] font-mono">{{ d.tokens }}t</span>
              </label>
            </div>
          </div>
        </a-tab-pane>

        <!-- Tab ② 拖拽 / 选择文件 -->
        <a-tab-pane key="files" :tab="t('workbenchSkillTabFiles')">
          <div
            class="rounded-lg px-3 py-6 text-center text-xs cursor-pointer transition"
            style="border: 1px dashed var(--wb-stroke-strong)"
            :class="dragOver ? 'bg-[var(--wb-surface-active)]' : ''"
            @click="fileEl?.click()"
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
          >
            <i class="fas fa-file-arrow-up mr-1 text-[var(--wb-accent)]"></i>
            <template v-if="pickedFiles.length">
              {{ pickedFiles.map((f) => f.name).join(', ') }}
            </template>
            <template v-else> {{ t('workbenchSkillImportDrop') }} </template>
          </div>
          <!-- .md 预览 -->
          <pre
            v-if="mdPreview"
            class="mt-1 text-[11px] max-h-40 overflow-y-auto p-2 rounded bg-[var(--wb-surface)] text-[var(--wb-text-2)] whitespace-pre-wrap"
            >{{ mdPreview }}</pre
          >
          <input
            ref="fileEl"
            type="file"
            multiple
            accept=".md,.zip"
            class="hidden"
            @change="onFilePicked"
          />
        </a-tab-pane>

        <!-- Tab ③ 粘贴 -->
        <a-tab-pane key="paste" :tab="t('workbenchSkillTabPaste')">
          <a-textarea
            v-model:value="pasted"
            :rows="10"
            :placeholder="t('workbenchSkillImportPastePh')"
            class="wb-tech-input font-mono !text-xs"
          />
        </a-tab-pane>
      </a-tabs>

      <!-- 冲突策略 -->
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--wb-text-2)]">{{ t('workbenchSkillConflict') }}</span>
        <a-select v-model:value="mode" size="small" style="width: 140px">
          <a-select-option value="skip">skip</a-select-option>
          <a-select-option value="overwrite">overwrite</a-select-option>
          <a-select-option value="rename">rename (-2)</a-select-option>
        </a-select>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open', 'imported'])

const { t } = useI18n()
const appStore = useAppStore()
const origin = computed(() => appStore.config?.serverHost || window.location.origin)

const activeTab = ref('scan')
const scanning = ref(false)
const sources = ref([])
// 勾选待导入：key = `${label}|${name}` → { dir, source }（默认全不选）
const scanPicks = ref(new Map())
const pickedFiles = ref([])
const mdPreview = ref('')
const pasted = ref('')
const mode = ref('skip')
const importing = ref(false)
const dragOver = ref(false)
const fileEl = ref(null)

function scanKey(src, d) {
  return `${src.label}|${d.name}`
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      activeTab.value = 'scan'
      scanPicks.value = new Map()
      pickedFiles.value = []
      mdPreview.value = ''
      pasted.value = ''
      scan()
    }
  },
)

async function scan() {
  scanning.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/skills/scan-local`)
    const json = await res.json()
    sources.value = json?.data ?? []
  } finally {
    scanning.value = false
  }
}

function toggleScanPick(src, d, e) {
  const key = scanKey(src, d)
  if (e.target.checked) scanPicks.value.set(key, { dir: d.dir, source: src.source })
  else scanPicks.value.delete(key)
}

/** 全选：勾所有未导入的（已导入的交给冲突策略，勾了也只会 skip） */
function selectAllScan() {
  for (const src of sources.value) {
    for (const d of src.skills) {
      if (!d.alreadyImported) {
        scanPicks.value.set(scanKey(src, d), { dir: d.dir, source: src.source })
      }
    }
  }
}

/** 反选：已勾的取消，未勾的全勾（含已导入） */
function invertScan() {
  for (const src of sources.value) {
    for (const d of src.skills) {
      const key = scanKey(src, d)
      if (scanPicks.value.has(key)) scanPicks.value.delete(key)
      else scanPicks.value.set(key, { dir: d.dir, source: src.source })
    }
  }
}

function onFilePicked(e) {
  addFiles([...(e.target.files ?? [])])
  e.target.value = ''
}

function onDrop(e) {
  dragOver.value = false
  addFiles([...(e.dataTransfer?.files ?? [])])
}

async function addFiles(files) {
  for (const f of files) {
    const lower = f.name.toLowerCase()
    if (lower.endsWith('.md')) {
      pickedFiles.value.push(f)
      // 只预览最后一个 .md（避免列表爆掉）
      mdPreview.value = (await f.text()).slice(0, 4000)
    } else if (lower.endsWith('.zip')) {
      pickedFiles.value.push(f)
    } else {
      message.warning(`unsupported: ${f.name}`)
    }
  }
}

async function doImport() {
  importing.value = true
  const total = { imported: 0, skipped: 0, failed: 0, errors: [] }
  try {
    // ① 扫描勾选：逐目录导入（保留来源标记）
    for (const { dir, source } of scanPicks.value.values()) {
      const r = await postJson('/api/workbench/skills/import-dir', {
        srcPath: dir,
        source,
        mode: mode.value,
      })
      accumulate(total, r)
    }
    // ② 文件（.md / .zip）
    for (const f of pickedFiles.value) {
      const fd = new FormData()
      fd.append('file', f, f.name)
      fd.append('source', 'manual')
      fd.append('mode', mode.value)
      const r = await postForm('/api/workbench/skills/import', fd)
      accumulate(total, r)
    }
    // ③ 粘贴
    if (pasted.value.trim()) {
      const blob = new File([pasted.value], 'SKILL.md', { type: 'text/markdown' })
      const fd = new FormData()
      fd.append('file', blob, 'SKILL.md')
      fd.append('source', 'manual')
      fd.append('mode', mode.value)
      const r = await postForm('/api/workbench/skills/import', fd)
      accumulate(total, r)
    }

    if (total.imported + total.skipped + total.failed === 0) {
      message.info(t('workbenchSkillEmpty'))
      return
    }
    message.success(
      t('workbenchSkillImportDone')
        .replace('{n}', total.imported)
        .replace('{m}', total.skipped)
        .replace('{k}', total.failed),
    )
    for (const err of total.errors.slice(0, 3)) message.error(err)
    close()
    emit('imported')
  } finally {
    importing.value = false
  }
}

function accumulate(total, r) {
  if (!r) {
    total.failed++
    return
  }
  total.imported += r.imported?.length ?? 0
  total.skipped += r.skipped?.length ?? 0
  total.failed += r.failed?.length ?? 0
  for (const f of r.failed ?? []) total.errors.push(`${f.name}: ${f.error}`)
}

async function postJson(path, body) {
  try {
    const res = await fetch(`${origin.value}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    return json?.success ? json.data : null
  } catch {
    return null
  }
}

async function postForm(path, fd) {
  try {
    const res = await fetch(`${origin.value}${path}`, { method: 'POST', body: fd })
    const json = await res.json()
    return json?.success ? json.data : null
  } catch {
    return null
  }
}

function close() {
  emit('update:open', false)
}
</script>
