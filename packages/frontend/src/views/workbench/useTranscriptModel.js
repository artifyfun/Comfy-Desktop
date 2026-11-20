/**
 * codex 条目转录模型（composable）——workbench/index.vue 拆分（第一批①a）。
 *
 * 抄 codex app-server/dsh transcript：item.id → 消息行索引，started 占行，
 * updated/completed 原位 upsert。本文件只做「消息模型 → 展示模型」的纯转换：
 * tool_item 摘要/折叠、回合级过程分组、todo/合成进度卡、执行副作用统一分派。
 * 依赖（messages/busy/artifacts/t/pushMsg 等）经参数注入，零组件耦合。
 */
import { reactive, computed } from 'vue'

/** tool_item 摘要行（图标 + 标签） */
export function toolItemSummary(item) {
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

/** 折叠 tool 行终态判定：item 自身失败（type=error 或 status error/failed） */
export function toolItemFailed(item) {
  return !!item && (item.status === 'error' || item.status === 'failed' || item.type === 'error')
}

export function toolItemRunning(item) {
  // 各 item 的 in-flight 状态字段统一收口
  return (
    item.status === 'in_progress' ||
    item.status === 'inProgress' ||
    (item.type === 'command_execution' && item.exit_code === undefined) ||
    false
  )
}

export function toolItemDetail(item) {
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

// P1-B3:todo_list 是任务级进度卡(独立渲染,不参与「过程(N 步)」折叠)；
// 其余 tool_item(reasoning/工具)是活动级条目(可折叠/合成 activity 步骤)。
const isTodoMsg = (m) =>
  m && m.kind === 'tool_item' && m.toolItem && m.toolItem.type === 'todo_list'
const isActivityMsg = (m) =>
  m && m.kind === 'tool_item' && m.toolItem && m.toolItem.type !== 'todo_list'

/**
 * 转录模型 composable。
 *
 * @param deps { messages, busy, artifacts, t, pushMsg } —— 页面状态注入
 */
export function useTranscriptModel(deps) {
  const { messages, busy, t, pushMsg } = deps

  const expandedToolIds = reactive(new Set())

  function toggleToolItem(m) {
    const id = m.toolItem?.id
    if (!id || !toolItemDetail(m.toolItem)) return
    if (expandedToolIds.has(id)) expandedToolIds.delete(id)
    else expandedToolIds.add(id)
  }

  // 回合级过程折叠：同 turn 相邻 tool_item 消息聚合为一行「过程（N 步）」。
  // 仅组首 index 有映射；组内非首条由组首统一渲染，不单独占行。
  // P1-B3:todo_list 卡不参与折叠(任务级进度卡独立成行,见模板 isTodoMsg 分支)——它
  // 天然打断相邻 tool_item 的连续聚合(前后工具各自成组,互不横跨进度卡)。
  const processGroups = computed(() => {
    const map = new Map()
    const msgs = messages.value
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (!m || !isActivityMsg(m)) continue
      const prev = msgs[i - 1]
      if (prev && isActivityMsg(prev) && prev.turnId != null && prev.turnId === m.turnId) continue
      let j = i
      while (j < msgs.length && msgs[j] && isActivityMsg(msgs[j])) {
        if (j > i && msgs[j].turnId !== m.turnId) break
        j++
      }
      map.set(i, { start: i, end: j - 1, count: j - i })
    }
    return map
  })
  const expandedProcessGroups = reactive(new Set())

  function processGroupAt(i) {
    const g = processGroups.value.get(i)
    // 单条目不聚合（保持原标题行）；旧数据（无 turnId）天然 count=1 走原样
    return g && g.count > 1 ? g : null
  }

  /** 组内非首条：由组首聚合渲染，跳过占行（仅活动级条目参与；todo 卡独立成行） */
  function processGroupSkipped(i) {
    const m = messages.value[i]
    const prev = messages.value[i - 1]
    return !!(
      isActivityMsg(m) &&
      prev &&
      isActivityMsg(prev) &&
      m.turnId != null &&
      prev.turnId === m.turnId
    )
  }

  function processGroupItems(g) {
    return messages.value.slice(g.start, g.end + 1)
  }

  /** turn 组收集：同 turnId 的连续 agent 消息（时间线归组基准） */
  function turnGroupItems(i) {
    const base = messages.value[i]
    if (!base || base.turnId == null) return [{ m: base, i }]
    const out = []
    let j = i
    while (j < messages.value.length) {
      const x = messages.value[j]
      if (j > i && (x.role !== 'agent' || x.turnId !== base.turnId)) break
      out.push({ m: x, i: j })
      j++
    }
    return out
  }

  /**
   * P1-B3 回合级进度模型（方案 C=A+B 混合，供 ProgressCard 消费）：
   * - 原生优先(mode 'todo')：turn 内有 todo_list 消息 → 任务清单卡。卡在消息流
   *   原位渲染(见模板 isTodoMsg 分支),此处只取 running 判定口径;
   * - 合成兜底(mode 'activity')：无原生 todo 且 turn 存在**在途** reasoning/工具
   *   条目时,把全 turn 活动条目归一为步骤叙事卡(置顶渲染,期间隐藏重复的
   *   「过程(N 步)」折叠行);全完成后回落既有折叠行——终态/历史零新增视觉;
   * - 纯文本回合 / 全终态 → null(不占位)。
   */
  function turnProgressModel(turnFirst) {
    const items = turnGroupItems(turnFirst)
    const todoEntry = items.find((x) => isTodoMsg(x.m))
    if (todoEntry) {
      const ti = todoEntry.m.toolItem
      const list = ti.items || []
      const done = list.filter((it) => it && it.completed === true).length
      return {
        mode: 'todo',
        title: t('workbenchTaskProgress'),
        // 头部 spinner 口径:updated 全勾帧先于 completed 事件到达时也不闪 spinner
        running: ti.status === 'in_progress' && busy.value && done < list.length,
        items: list,
      }
    }
    const acts = items.filter((x) => isActivityMsg(x.m))
    if (!acts.length) return null
    if (!acts.some((x) => toolItemRunning(x.m.toolItem))) return null // 全终态 → 回落
    return {
      mode: 'activity',
      title: t('workbenchExecProgress'),
      running: true,
      steps: acts.map(({ m }) => {
        const ti = m.toolItem
        const sum = toolItemSummary(ti)
        return {
          label: sum.label,
          icon: sum.icon,
          status: toolItemRunning(ti) ? 'in_progress' : 'completed',
          detail: toolItemDetail(ti) || '',
        }
      }),
    }
  }

  /** activity 卡展示期间,该 turn 的「过程(N 步)」折叠行整体隐藏(防与卡重复) */
  function turnActCover(i) {
    const base = messages.value[i]
    if (!base || base.turnId == null || !isActivityMsg(base)) return false
    let j = i
    while (j > 0) {
      const p = messages.value[j - 1]
      if (p && p.role === 'agent' && p.turnId === base.turnId) j -= 1
      else break
    }
    const model = turnProgressModel(j)
    return !!(model && model.mode === 'activity')
  }

  /** 原生 todo 卡头部 running 口径：快照 in_progress 且页面仍在忙且未全勾才转 spinner
   *  (updated 全勾帧先于 completed 事件到达时保持冷静,不闪 spinner) */
  function todoCardRunning(toolItem) {
    const list = (toolItem && toolItem.items) || []
    return !!(
      toolItem &&
      toolItem.status === 'in_progress' &&
      busy.value &&
      list.some((it) => !it || it.completed !== true)
    )
  }

  function processGroupRunning(g) {
    return messages.value
      .slice(g.start, g.end + 1)
      .some((x) => x.toolItem && toolItemRunning(x.toolItem))
  }

  function processGroupFailed(g) {
    return messages.value
      .slice(g.start, g.end + 1)
      .some((x) => x.toolItem && toolItemFailed(x.toolItem))
  }

  function toggleProcessGroup(i) {
    const g = processGroupAt(i)
    if (!g) return
    if (expandedProcessGroups.has(i)) expandedProcessGroups.delete(i)
    else expandedProcessGroups.add(i)
  }

  /**
   * 移除 AI 占位进度气泡（「AI 正在决策…」/「执行失败，AI 正在分析…」）。
   * 不能只 pop 尾部：decide 阶段的过程条目（tool_item）追加在占位之后，占位
   * 可能已不在数组末尾，尾部 pop 会漏掉它，导致 loading 气泡残留/错位。
   */
  function dismissDecidingProgress() {
    const placeholders = [t('workbenchDeciding'), t('workbenchAutoRecovering')]
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.kind === 'progress' && placeholders.includes(m.text)) {
        messages.value.splice(i, 1)
      }
    }
  }

  return {
    isTodoMsg,
    isActivityMsg,
    expandedToolIds,
    toggleToolItem,
    processGroups,
    expandedProcessGroups,
    processGroupAt,
    processGroupSkipped,
    processGroupItems,
    turnProgressModel,
    turnActCover,
    todoCardRunning,
    processGroupRunning,
    processGroupFailed,
    toggleProcessGroup,
    dismissDecidingProgress,
    turnGroupItems,
  }
}
