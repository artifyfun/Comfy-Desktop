<template>
  <div v-if="attachments.length" class="attachment-rail flex gap-2 px-1 pb-1">
    <div
      v-for="(a, i) in attachments"
      :key="i"
      class="relative group shrink-0"
      :class="a.uploading ? 'opacity-60' : ''"
    >
      <div
        class="w-16 h-16 rounded-lg overflow-hidden bg-[var(--wb-surface-deep)] border border-[var(--wb-stroke-strong)] flex items-center justify-center"
      >
        <img
          v-if="a.kind === 'image' && (a._preview || a.previewUrl)"
          :src="a._preview || a.previewUrl"
          class="w-full h-full object-cover"
          :alt="a.filename"
        />
        <div v-else class="text-center">
          <i :class="kindIcon(a.kind)" class="text-xl text-[var(--wb-accent)]"></i>
          <div class="text-[10px] text-[var(--wb-text-2)] mt-0.5 truncate w-14">
            {{ a.filename }}
          </div>
        </div>
      </div>
      <span
        v-if="a.uploading"
        class="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg"
      >
        <a-spin size="small" />
      </span>
      <button
        class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[var(--wb-surface-hover)] text-white text-xs hidden group-hover:flex items-center justify-center hover:bg-[var(--wb-danger)]"
        @click="$emit('remove', i)"
      >
        <i class="fas fa-times"></i>
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  attachments: { type: Array, default: () => [] },
})
defineEmits(['remove'])

function kindIcon(kind) {
  if (kind === 'image') return 'fas fa-image'
  if (kind === 'video') return 'fas fa-film'
  if (kind === 'audio') return 'fas fa-music'
  return 'fas fa-file'
}
</script>
