<!--
  video/audio 原生媒体节点（S4b）——HTML overlay 播放器
  Konva 不能内嵌 video/audio 控件，采用 AppNodeCard 同款 overlay 方案：
  宿主把节点世界坐标转屏幕 pos 传入，本组件绝对定位渲染原生播放器。
  拖动/缩放由宿主 overlay 联动重算（viewport watch → pos 更新）。
-->
<script setup>
import { useI18n } from '@/utils/i18n'
const { t } = useI18n()

const emit = defineEmits(['upload'])

/**
 * fix(媒体节点不可拖): overlay 全覆盖在 Konva 之上且 mousedown.stop,
 * 拖拽起点永远到不了 Konva 占位 group —— 媒体节点只能靠边缘细缝拖动,
 * 且拖动时 overlay(Vue 调度)滞后 Konva(同帧)一拍 → "两个区块"。
 * 现将非控件区域的 mousedown 转发给 Konva group 手动 startDrag:
 *  - video/audio 控件自身的点击(播放/进度条/音量)不触发拖拽;
 *  - 边框 padding/空白区域按下即拖,与 Konva 原生拖拽体验一致;
 *  - Konva dragmove 由宿主 onNodeDrag 写回数据 + 直写 overlay 位置(同帧对齐)。
 */
const props = defineProps({
  node: { type: Object, required: true },
  pos: { type: Object, required: true },
})
function onOverlayDown(e) {
  const t = e.target
  // 控件自身（video 播放器/上传按钮）的交互不劫持
  if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO' || t.closest?.('button'))) return
  // 把 mousedown 原样转发给 Konva 画布层（同坐标）：Konva 内部走完整
  // onItemDown（选中/平移意图/hover）→ dragmove 链——与原生拖拽完全一致。
  // overlay 不再吃掉事件（原先 mousedown.stop 导致媒体节点只能从边缘拖）。
  const content = document.querySelector('.konvajs-content')
  if (content) {
    e.stopPropagation()
    content.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        buttons: e.buttons,
      }),
    )
  }
}
</script>

<template>
  <div
    class="absolute inset-0 rounded-xl overflow-hidden border border-[var(--wb-stroke)] bg-black/80 shadow-lg"
    @mousedown="onOverlayDown"
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
