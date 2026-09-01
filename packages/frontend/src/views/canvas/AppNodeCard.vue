<template>
  <div
    class="app-node-panel"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    @mousedown.stop
    @wheel.stop
  >
    <div class="flex items-center justify-between mb-2">
      <span class="font-medium text-[var(--wb-text-1)] flex items-center gap-1.5 text-xs">
        <i class="fas fa-cube text-[var(--wb-accent)]"></i>
        {{ node.name || node.appId }}
        <span v-if="running" class="text-[var(--wb-accent)]"
          ><i class="fas fa-spinner fa-spin"></i
        ></span>
      </span>
      <button
        class="text-slate-400 hover:text-white"
        :title="t('canvasAppNodeClose')"
        @click="$emit('close')"
      >
        <i class="fas fa-times"></i>
      </button>
    </div>

    <!-- 参数表单（paramsNodes 派生；空模板提示） -->
    <div v-if="fields.length" class="fields">
      <div v-for="f in fields" :key="f.nodeId + '.' + f.key" class="field">
        <label class="field-label" :title="f.label">{{ f.label }}</label>
        <textarea
          v-if="f.widget === 'text'"
          rows="2"
          class="field-input resize-none"
          :value="paramValue(f) ?? ''"
          :placeholder="defValOf(f)"
          @input="setParam(f, $event.target.value)"
        ></textarea>
        <a-switch
          v-else-if="f.widget === 'switch'"
          size="small"
          :checked="!!paramValue(f)"
          @change="(v) => setParam(f, v)"
        />
        <div v-else-if="f.widget === 'slider'" class="flex items-center gap-2">
          <a-slider
            class="flex-1 min-w-0"
            :min="f.min ?? 0"
            :max="f.max ?? 100"
            :step="f.step ?? 1"
            :value="Number(paramValue(f) ?? defValOf(f) ?? f.min ?? 0)"
            @change="(v) => setParam(f, v)"
          />
          <span class="num-val">{{ paramValue(f) ?? defValOf(f) ?? '' }}</span>
        </div>
        <a-input-number
          v-else-if="f.widget === 'number'"
          size="small"
          class="w-full"
          :min="f.min"
          :max="f.max"
          :step="f.step"
          :precision="f.precision"
          :value="paramValue(f) ?? null"
          @change="(v) => setParam(f, v)"
        />
        <select
          v-else-if="f.widget === 'select'"
          class="field-input"
          :value="paramValue(f) ?? ''"
          @change="setParam(f, $event.target.value)"
        >
          <option value="">（默认）</option>
          <option v-for="opt in selectOptions(f)" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <div
          v-else-if="f.widget === 'image' || f.widget === 'audio' || f.widget === 'video'"
          class="flex items-center gap-1"
        >
          <input
            class="field-input"
            :value="paramValue(f) ?? ''"
            :placeholder="
              f.widget === 'image' ? t('canvasAppNodeImagePh') : t('canvasAppNodeFilePh')
            "
            @input="setParam(f, $event.target.value)"
          />
          <button
            class="pick-btn"
            :title="t('canvasAppNodePickFromCanvas')"
            @click="$emit('pick-canvas', f)"
          >
            <i class="fas fa-images"></i>
          </button>
        </div>
        <input
          v-else
          class="field-input"
          :value="paramValue(f) ?? ''"
          @input="setParam(f, $event.target.value)"
        />
      </div>
    </div>
    <div v-else class="text-slate-500 text-xs py-2">{{ t('canvasAppNodeNoParams') }}</div>

    <!-- 上游喂养提示 -->
    <div v-if="fedLines.length" class="fed">
      <i class="fas fa-link text-[var(--wb-accent)]"></i>
      <span v-for="(line, i) in fedLines" :key="i" class="fed-item">{{ line }}</span>
    </div>

    <div class="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--wb-stroke)]">
      <button
        class="run-btn"
        :disabled="running"
        :title="t('canvasAppNodeRun')"
        @click="$emit('run')"
      >
        <i class="fas" :class="running ? 'fa-spinner fa-spin' : 'fa-play'"></i>
        {{ running ? t('canvasAppNodeRunning') : t('canvasAppNodeRun') }}
      </button>
      <button class="ghost-btn" :title="t('canvasAppNodeOpenFull')" @click="$emit('open-full')">
        <i class="fas fa-up-right-from-square"></i>
      </button>
      <span v-if="node.statusText" class="status-text" :class="node.status">{{
        node.statusText
      }}</span>
    </div>
  </div>
</template>

<script setup>
/**
 * App 节点展开面板（HTML overlay；锚定世界坐标节点，由父级换算屏幕坐标）。
 * 参数写回 node.params（响应式对象直写）；运行/关闭/拾取画布图 emit 给宿主。
 */
import { computed } from 'vue'
import { useI18n } from '@/utils/i18n'
import { paramFieldsFromTemplate } from './appNode'

const props = defineProps({
  node: { type: Object, required: true },
  app: { type: Object, default: null }, // 完整 app（含 template）
  pos: { type: Object, required: true }, // 屏幕坐标 {x,y}
  fedLines: { type: Array, default: () => [] },
})
const { t } = useI18n()
const emit = defineEmits(['close', 'run', 'pick-canvas', 'open-full', 'update-param'])
const running = computed(() => props.node.status === 'running')

const fields = computed(() => paramFieldsFromTemplate(props.app))

// app 默认值（template.prompt[nodeId].inputs[key]）供 placeholder
function defValOf(f) {
  const v = props.app?.template?.prompt?.[f.nodeId]?.inputs?.[f.key]
  return v === undefined || Array.isArray(v) ? '' : v
}

function paramValue(f) {
  const v = props.node.params?.[f.nodeId]?.[f.key]
  return v === undefined ? null : v
}
// prop 不可直改（vue/no-mutating-props）：参数写回经 update-param 事件由宿主落
function setParam(f, v) {
  emit('update-param', { nodeId: f.nodeId, key: f.key, value: v })
}
function selectOptions() {
  // combo 无 options 快照时不可枚举（paramsNodes 未带 values）——留给手填
  return []
}
</script>

<style scoped>
.app-node-panel {
  position: absolute;
  z-index: 25;
  width: 320px;
  max-height: 420px;
  overflow-y: auto;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--wb-stroke);
  background: var(--wb-surface);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.field-label {
  font-size: 11px;
  color: var(--wb-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.field-input {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--wb-stroke);
  background: rgba(0, 0, 0, 0.2);
  padding: 4px 8px;
  color: var(--wb-text-1);
  outline: none;
  font-size: 12px;
}
.field-input:focus {
  border-color: var(--wb-accent);
}
.num-val {
  min-width: 28px;
  text-align: right;
  color: var(--wb-text-2);
  font-size: 11px;
}
.pick-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--wb-stroke);
  color: var(--wb-text-2);
}
.pick-btn:hover {
  color: var(--wb-accent);
  border-color: var(--wb-accent);
}
.fed {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--wb-text-2);
}
.fed-item {
  padding: 1px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--wb-accent) 12%, transparent);
  color: var(--wb-accent);
}
.run-btn {
  margin-left: auto;
  padding: 5px 14px;
  border-radius: 8px;
  background: var(--wb-accent);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
.run-btn:disabled {
  opacity: 0.45;
}
.ghost-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--wb-stroke);
  color: var(--wb-text-2);
}
.ghost-btn:hover {
  color: var(--wb-accent);
  border-color: var(--wb-accent);
}
.status-text {
  font-size: 11px;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-text.success {
  color: #34d399;
}
.status-text.error {
  color: #f87171;
}
.status-text.running {
  color: var(--wb-accent);
}
</style>
