/**
 * M4 调试路由前端辅助：诊断分类 → UI 文案的纯函数层。
 * diagnoseArtifact/applyDiagnosisFix 的副作用（fetch/proposeCanvasOps）留在
 * index.vue，这里只放可单测的映射逻辑。
 */

/** 服务端 ClassifiedError（/api/canvas/debug 的 data 字段） */
export function diagnosisCategoryKey(category) {
  const known = ['missing_model', 'bad_param', 'broken_graph', 'oom', 'auth', 'unknown']
  return known.includes(category) ? category : 'unknown'
}

/** i18n key：workbenchDiagCat_<key> */
export function diagnosisI18nKey(category) {
  return `workbenchDiagCat_${diagnosisCategoryKey(category)}`
}

/** 诊断卡是否可显示「应用修复」按钮：有 fixOps 且在 embed 模式（走 M2 人审通道） */
export function canApplyFix(diagnosis, isEmbed) {
  return Boolean(isEmbed && diagnosis?.suggestion?.fixOps?.length)
}

/** 建议文案：服务端 text 优先，缺失时按 kind 兜底（不出现空卡片） */
export function diagnosisText(diagnosis, fallbackByKind = {}) {
  const text = diagnosis?.suggestion?.text
  if (text) return text
  return fallbackByKind[diagnosis?.suggestion?.kind] || fallbackByKind.manual || ''
}
