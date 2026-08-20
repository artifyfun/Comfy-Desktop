<template>
  <div class="params-manager">
    <a-table
      :data-source="paramsNodes"
      :columns="columns"
      :loading="state.tableLoading"
      size="small"
      :pagination="false"
      :scroll="{ y: 360 }"
      row-key="name"
      :custom-row="customRow"
    >
      <template #bodyCell="{ column, record, index }">
        <template v-if="column.key === 'name'">
          <div class="cell-name">
            <div class="color-block" :style="{ background: record.color }"></div>
            <a-tooltip placement="top" :title="record.name">
              <div>{{ record.name }}</div>
            </a-tooltip>
          </div>
        </template>
        <template v-else-if="column.key === 'category'">
          {{ record.category === 'input' ? t('input') : t('output') }}
        </template>
        <template v-else-if="column.key === 'title'">
          <a-tooltip placement="top" :title="record.title || record.type">
            <div>{{ record.title || record.type }}</div>
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'operation'">
          <a-tooltip placement="top" :title="t('edit')">
            <EditOutlined class="operation-icon" @click.stop="openEdit(record)" />
          </a-tooltip>
          <a-tooltip placement="top" :title="t('delete')">
            <DeleteOutlined class="operation-icon" @click.stop="removeParams(record)" />
          </a-tooltip>
          <a-tooltip placement="top" :title="t('moveUp')">
            <ArrowUpOutlined
              class="operation-icon"
              :class="{ disabled: index === 0 }"
              @click.stop="moveRow(index, -1)"
            />
          </a-tooltip>
          <a-tooltip placement="top" :title="t('moveDown')">
            <ArrowDownOutlined
              class="operation-icon"
              :class="{ disabled: index === paramsNodes.length - 1 }"
              @click.stop="moveRow(index, 1)"
            />
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'renderComponent'">
          {{ renderComponentLabel(record.renderComponent) }}
        </template>
      </template>
    </a-table>

    <!-- 编辑弹窗：填表单替代原行内编辑，避免误触、便于一次看清全部可改字段 -->
    <a-modal
      v-model:open="state.editOpen"
      :title="t('editParam')"
      :ok-text="t('save')"
      :cancel-text="t('cancel')"
      destroy-on-close
      @ok="saveEdit"
    >
      <a-form layout="vertical" v-if="state.editing">
        <a-form-item :label="t('paramName')">
          <a-input :value="state.editing.name" disabled />
        </a-form-item>
        <a-form-item :label="t('belongingNode')">
          <a-input :value="state.editing.title || state.editing.type" disabled />
        </a-form-item>
        <a-form-item :label="t('alias')">
          <a-input v-model:value="state.editing.description" :placeholder="t('aliasPlaceholder')" />
        </a-form-item>
        <a-form-item :label="t('renderComponent')">
          <a-select
            v-model:value="state.editing.renderComponent"
            :options="options"
            style="width: 100%"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import {
  EditOutlined,
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons-vue'
import { t } from '@/utils/i18n'

const props = defineProps({
  paramsNodes: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['postMessage'])

const state = reactive({
  tableLoading: false,
  editOpen: false,
  editing: null,
})

const columns = [
  { title: t('paramName'), key: 'name', dataIndex: 'name', width: 200, ellipsis: true },
  { title: t('alias'), key: 'description', dataIndex: 'description', ellipsis: true },
  { title: t('paramType'), key: 'category', dataIndex: 'category', width: 100 },
  { title: t('belongingNode'), key: 'title', ellipsis: true },
  { title: t('renderComponent'), key: 'renderComponent', width: 160 },
  { title: t('operation'), key: 'operation', width: 160, fixed: 'right' },
]

const options = ref([
  { label: t('textarea'), value: 'textarea' },
  { label: t('switch'), value: 'switch' },
  { label: t('slider'), value: 'slider' },
  { label: t('inputNumber'), value: 'input-number' },
  { label: t('imageUploader'), value: 'image-uploader' },
  { label: t('audioUploader'), value: 'audio-uploader' },
  { label: t('videoUploader'), value: 'video-uploader' },
  { label: t('fileUploader'), value: 'file-uploader' },
  { label: t('audio'), value: 'audio' },
  { label: t('video'), value: 'video' },
  { label: t('select'), value: 'select' },
  { label: t('postImage'), value: 'post-image' },
  { label: t('text'), value: 'text' },
])

const renderComponentLabel = (value) => {
  const hit = options.value.find((o) => o.value === value)
  return hit ? hit.label : value
}

const updateParamsNodes = (nodes) => {
  const message = JSON.stringify({
    eventType: 'updateParamsNodes',
    data: nodes,
  })
  emit('postMessage', message)
}

const removeParams = (node) => {
  const nodes = props.paramsNodes.filter((item) => item !== node)
  updateParamsNodes(nodes)
}

// 上下移动替代原拖拽排序（无需拖拽库，触点更明确）
const moveRow = (index, offset) => {
  const target = index + offset
  if (target < 0 || target >= props.paramsNodes.length) return
  const nodes = [...props.paramsNodes]
  const [row] = nodes.splice(index, 1)
  nodes.splice(target, 0, row)
  updateParamsNodes(nodes)
}

// 点击行 → 画布定位到对应节点
const centerOnNode = (node) => {
  const message = JSON.stringify({
    eventType: 'centerOnNode',
    data: node,
  })
  emit('postMessage', message)
}

const customRow = (record) => ({
  onClick: () => centerOnNode(record),
})

// 编辑弹窗：浅拷贝工作副本，取消不落盘，保存才 postMessage 回写
const openEdit = (record) => {
  state.editing = { ...record }
  state.editOpen = true
}

const saveEdit = () => {
  if (!state.editing) return
  // 编辑对象是浅拷贝副本，按 name 匹配回写原列表
  const nodes = props.paramsNodes.map((item) =>
    item.name === state.editing.name ? { ...item, ...state.editing } : item,
  )
  updateParamsNodes(nodes)
  state.editOpen = false
}
</script>

<style scoped lang="less">
.params-manager {
  margin-top: 10px;
  .cell-name {
    display: flex;
    align-items: center;
    .color-block {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 10px;
      flex-shrink: 0;
    }
  }
  .operation-icon {
    font-size: 14px;
    margin-right: 10px;
    cursor: pointer;
    &.disabled {
      opacity: 0.3;
      cursor: not-allowed;
      pointer-events: none;
    }
  }
}
</style>
