<!--
  AssetLibrary.vue — C-H5 创作资产库面板（对标建议 #4 的 UI 侧）

  数据源：GET/POST /api/workbench/assets*（assetsStore，与 wb_assets MCP 工具同源）。
  功能：清单（kind 图标 + 名称 + refs 数 + seed + 更新时间）、删除（confirm）、
  新建/更新表单（kind/name/refs 逗号分隔/seed）。
  契约：纯 props + 自取数据（挂载时 GET，操作后刷新）；不依赖 store/Pinia。
-->
<template>
  <div
    class="asset-library rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface)] p-3 text-xs"
  >
    <div class="mb-2 flex items-center justify-between">
      <span class="font-medium text-[var(--wb-text-1)]">
        <i class="fas fa-box-open mr-1 text-[var(--wb-accent)]"></i>{{ t('assetLibTitle') }}
      </span>
      <button
        class="rounded px-2 py-0.5 text-[11px] text-[var(--wb-accent-hover)] hover:bg-[var(--wb-accent)]/10"
        data-testid="asset-new"
        @click="formOpen = !formOpen"
      >
        <i class="fas fa-plus mr-0.5"></i>{{ t('assetLibNew') }}
      </button>
    </div>

    <!-- 新建/更新表单 -->
    <div v-if="formOpen" class="mb-3 space-y-2 rounded-md border border-[var(--wb-stroke)] p-2">
      <select
        v-model="form.kind"
        class="w-full rounded border border-[var(--wb-stroke)] bg-transparent px-2 py-1 text-[var(--wb-text-1)]"
      >
        <option value="character">角色</option>
        <option value="style">风格</option>
        <option value="prop">道具</option>
        <option value="other">其他</option>
      </select>
      <input
        v-model="form.name"
        :placeholder="t('assetLibNamePh')"
        class="w-full rounded border border-[var(--wb-stroke)] bg-transparent px-2 py-1 text-[var(--wb-text-1)]"
      />
      <input
        v-model="form.refs"
        :placeholder="t('assetLibRefsPh')"
        class="w-full rounded border border-[var(--wb-stroke)] bg-transparent px-2 py-1 text-[var(--wb-text-2)]"
      />
      <input
        v-model="form.seed"
        type="number"
        :placeholder="t('assetLibSeedPh')"
        class="w-full rounded border border-[var(--wb-stroke)] bg-transparent px-2 py-1 text-[var(--wb-text-2)]"
      />
      <div class="flex gap-2">
        <button
          class="flex-1 rounded bg-[var(--wb-accent)] py-1 text-white"
          data-testid="asset-save"
          :disabled="!form.name.trim()"
          @click="save"
        >
          {{ editingId ? t('assetLibUpdate') : t('assetLibSave') }}
        </button>
        <button
          class="rounded border border-[var(--wb-stroke)] px-3 text-[var(--wb-text-2)]"
          @click="resetForm"
        >
          {{ t('assetLibCancel') }}
        </button>
      </div>
      <div v-if="formError" class="text-[11px] text-red-400">{{ formError }}</div>
    </div>

    <!-- 清单 -->
    <div v-if="assets.length === 0" class="py-3 text-center text-[var(--wb-text-3)]">
      {{ t('assetLibEmpty') }}
    </div>
    <div v-else class="space-y-1">
      <div
        v-for="a in assets"
        :key="a.id"
        data-testid="asset-item"
        class="flex items-center gap-2 rounded-md border border-[var(--wb-stroke)] px-2 py-1.5"
      >
        <span class="shrink-0" :title="a.kind">{{ kindIcon(a.kind) }}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[var(--wb-text-1)]">{{ a.name }}</div>
          <div class="text-[10px] text-[var(--wb-text-3)]">
            {{ a.kind }} · {{ t('assetLibRefs') }} {{ a.refs_count }} · seed {{ a.seed ?? '—' }}
          </div>
        </div>
        <button
          class="shrink-0 px-1 text-[var(--wb-text-2)] hover:text-[var(--wb-accent)]"
          :title="t('assetLibEdit')"
          @click="edit(a)"
        >
          <i class="fas fa-pen text-[10px]"></i>
        </button>
        <button
          class="shrink-0 px-1 text-[var(--wb-text-2)] hover:text-red-400"
          :title="t('assetLibRemove')"
          data-testid="asset-remove"
          @click="remove(a)"
        >
          <i class="fas fa-trash text-[10px]"></i>
        </button>
      </div>
    </div>

    <div v-if="msg" class="mt-2 text-[11px] text-[var(--wb-accent-hover)]">{{ msg }}</div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue'

export default {
  name: 'AssetLibrary',
  props: {
    t: { type: Function, required: true },
  },
  setup(props) {
    const assets = ref([])
    const formOpen = ref(false)
    const editingId = ref(null)
    const formError = ref('')
    const msg = ref('')
    const form = reactive({ kind: 'character', name: '', refs: '', seed: '' })

    async function api(path, body) {
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error((json && json.message) || 'HTTP ' + res.status)
      return json.data
    }

    async function refresh() {
      try {
        const d = await api('/api/workbench/assets')
        assets.value = d.assets || []
      } catch {
        assets.value = []
      }
    }
    onMounted(refresh)

    function resetForm() {
      formOpen.value = false
      editingId.value = null
      form.kind = 'character'
      form.name = ''
      form.refs = ''
      form.seed = ''
      formError.value = ''
    }

    async function save() {
      if (!form.name.trim()) return
      formError.value = ''
      try {
        await api('/api/workbench/assets/save', {
          kind: form.kind,
          name: form.name.trim(),
          refs: form.refs
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
          ...(form.seed !== '' ? { seed: Number(form.seed) } : {}),
          ...(editingId.value ? { id: editingId.value } : {}),
        })
        msg.value = t('assetLibSaved')
        resetForm()
        formOpen.value = false
        await refresh()
      } catch (e) {
        formError.value = e.message
      }
    }

    function edit(a) {
      formOpen.value = true
      editingId.value = a.id
      form.kind = a.kind
      form.name = a.name
      form.refs = (a.refs || []).join(', ')
      form.seed = a.seed ?? ''
    }

    async function remove(a) {
      try {
        await api('/api/workbench/assets/remove', { id: a.id })
        msg.value = ''
        await refresh()
      } catch (e) {
        formError.value = e.message
      }
    }

    function kindIcon(kind) {
      return { character: '👤', style: '🎨', prop: '📦', other: '📁' }[kind] || '📁'
    }

    return {
      assets,
      formOpen,
      editingId,
      form,
      formError,
      msg,
      save,
      edit,
      remove,
      resetForm,
      kindIcon,
    }
  },
}
</script>
