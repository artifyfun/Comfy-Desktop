<template>
  <aside
    data-v-assets
    class="flex h-full w-[232px] flex-col overflow-hidden border-r border-[var(--wb-stroke)] bg-[var(--wb-surface)] text-[var(--wb-text-1)]"
  >
    <div class="flex items-center justify-between border-b border-[var(--wb-stroke)] px-3 py-2">
      <span class="text-xs font-semibold">{{ t('canvasAssetsTitle') }}</span>
      <div class="flex items-center gap-1">
        <button
          :title="t('canvasAssetsImport')"
          class="rounded p-1 text-[var(--wb-text-2)] hover:bg-black/15 hover:text-[var(--wb-text-1)]"
          @click="pickFiles"
        >
          <i class="fas fa-file-import text-xs"></i>
        </button>
        <button
          :title="t('canvasLayersClose')"
          class="rounded p-1 text-[var(--wb-text-2)] hover:bg-black/15 hover:text-[var(--wb-text-1)]"
          @click="$emit('close')"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </div>
    </div>

    <!-- 上传区 -->
    <div
      class="m-2 cursor-pointer rounded-lg border border-dashed border-[var(--wb-stroke)] px-3 py-4 text-center text-[10px] text-[var(--wb-text-2)] transition hover:border-[var(--wb-accent)] hover:text-[var(--wb-accent)]"
      @click="pickFiles"
      @dragover.prevent
      @drop.prevent="onDropFiles"
    >
      <i class="fas fa-cloud-arrow-up mb-1 block text-lg"></i>
      {{ t('canvasAssetsDropHint') }}
    </div>

    <!-- 素材网格 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div v-if="!assets.length" class="mt-8 text-center text-[10px] text-[var(--wb-text-2)]">
        {{ t('canvasAssetsEmpty') }}
      </div>
      <div
        v-for="a in assets"
        :key="a.id"
        class="group relative mb-2 cursor-grab overflow-hidden rounded-lg border border-[var(--wb-stroke)] bg-black/20"
        :title="a.name + ' · ' + a.w + '×' + a.h"
        draggable="true"
        @dragstart="onDragStart($event, a)"
        @click="$emit('insert', a)"
      >
        <img :src="a.thumb" class="block w-full" style="aspect-ratio: 1; object-fit: cover" />
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[9px] text-slate-200 opacity-0 transition group-hover:opacity-100"
        >
          {{ a.name }}
        </div>
        <button
          class="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded bg-black/60 text-[9px] text-red-300 group-hover:flex hover:bg-red-500/80 hover:text-white"
          :title="t('canvasAssetsRemove')"
          @click.stop="removeAsset(a.id)"
        >
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>

    <div class="border-t border-[var(--wb-stroke)] px-3 py-1.5 text-[9px] text-[var(--wb-text-2)]">
      {{ assets.length }} {{ t('canvasAssetsCountUnit') }}
    </div>

    <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="onPick" />
  </aside>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from '@/utils/i18n'

defineProps({
  assets: { type: Array, required: true },
})
const emit = defineEmits(['insert', 'added', 'remove', 'close'])

const { t } = useI18n()
const fileInput = ref(null)

function pickFiles() {
  fileInput.value?.click()
}
function onPick(e) {
  addFiles([...e.target.files])
  e.target.value = ''
}
function onDropFiles(e) {
  addFiles([...(e.dataTransfer?.files || [])])
}
function onDragStart(e, a) {
  // HTML5 DnD：画布 wrap 的 @drop 里读 dataTransfer 拿素材 id
  e.dataTransfer.setData('application/x-artify-asset', a.id)
  e.dataTransfer.effectAllowed = 'copy'
}

/** 上传 → 降采样缩略图 + 全尺寸 persist dataURL，入索引（本地） */
function addFiles(files) {
  const imgs = files.filter((f) => f.type.startsWith('image/'))
  for (const f of imgs) {
    const url = URL.createObjectURL(f)
    const probe = new Image()
    probe.onload = () => {
      const make = (max) => {
        const s = Math.min(1, max / Math.max(probe.naturalWidth, probe.naturalHeight))
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(probe.naturalWidth * s))
        cv.height = Math.max(1, Math.round(probe.naturalHeight * s))
        cv.getContext('2d').drawImage(probe, 0, 0, cv.width, cv.height)
        return { dataUrl: cv.toDataURL('image/jpeg', 0.82), w: cv.width, h: cv.height }
      }
      const thumb = make(160) // 网格缩略图
      const persist = make(640) // 入画布的持久源（与 persistImage 同规格）
      emit('added', {
        name: f.name,
        thumb: thumb.dataUrl,
        persist: persist.dataUrl,
        w: probe.naturalWidth,
        h: probe.naturalHeight,
      })
      URL.revokeObjectURL(url)
    }
    probe.src = url
  }
}
function removeAsset(id) {
  emit('remove', id)
}
defineExpose({ addFiles })
</script>
