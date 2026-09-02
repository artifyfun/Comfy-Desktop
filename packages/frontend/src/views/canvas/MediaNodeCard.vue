<!--
  video/audio 原生媒体节点（S4b）——HTML overlay 播放器
  Konva 不能内嵌 video/audio 控件，采用 AppNodeCard 同款 overlay 方案：
  宿主把节点世界坐标转屏幕 pos 传入，本组件绝对定位渲染原生播放器。
  拖动/缩放由宿主 overlay 联动重算（viewport watch → pos 更新）。
-->
<script setup>
import { useI18n } from '@/utils/i18n'
const { t } = useI18n()
defineProps({
  node: { type: Object, required: true }, // {id,type:'video'|'audio',x,y,width,height,src,persist,name}
  pos: { type: Object, required: true }, // {x,y,w,h} 屏幕坐标（含缩放）
})
const emit = defineEmits(['upload'])
</script>

<template>
  <div
    class="absolute inset-0 rounded-xl overflow-hidden border border-[var(--wb-stroke)] bg-black/80 shadow-xl"
    @mousedown.stop
    @pointerdown.stop
    @dblclick.stop
  >
    <!-- video：播放器或空占位上传 -->
    <div v-if="node.type === 'video'" class="w-full h-full flex items-center justify-center">
      <video
        v-if="node.src"
        :src="node.src"
        controls
        class="w-full h-full object-contain"
        :data-media-node="node.id"
      ></video>
      <button
        v-else
        class="flex flex-col items-center gap-2 text-[var(--wb-text-2)] hover:text-[var(--wb-accent)] transition"
        :title="t('canvasMediaUploadVideo')"
        @click="emit('upload', node.id)"
      >
        <i class="fas fa-film text-2xl"></i>
        <span class="text-xs">{{ t('canvasMediaEmptyVideo') }}</span>
      </button>
    </div>
    <!-- audio：播放器或空占位上传 -->
    <div
      v-else
      class="w-full h-full flex flex-col items-center justify-center gap-3 px-3 bg-[var(--wb-surface)]"
    >
      <div v-if="node.src" class="w-full flex items-center gap-2">
        <i class="fas fa-music text-[var(--wb-accent)]"></i>
        <audio :src="node.src" controls class="w-full" :data-media-node="node.id"></audio>
      </div>
      <button
        v-else
        class="flex flex-col items-center gap-2 text-[var(--wb-text-2)] hover:text-[var(--wb-accent)] transition"
        :title="t('canvasMediaUploadAudio')"
        @click="emit('upload', node.id)"
      >
        <i class="fas fa-music text-2xl"></i>
        <span class="text-xs">{{ t('canvasMediaEmptyAudio') }}</span>
      </button>
    </div>
  </div>
</template>
