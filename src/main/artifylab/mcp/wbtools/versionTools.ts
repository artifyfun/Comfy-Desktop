/**
 * 模板（App）版本历史工具 —— `wb_app_versions`。
 *
 * 为什么需要：版本历史本身早就完整存在（gallery.db 的 `app_versions` 表 +
 * `appAssets` 的快照/列表/读取 + 前端 `VersionModal` 的列表与恢复），但**agent 侧
 * 此前没有任何出口**——AI 用 `wb_publish_workflow` 迭代过模板之后，如果某一版改坏了，
 * 它自己既看不到历史也退不回去，只能让用户去界面上手点。
 *
 * 恢复语义与前端 `VersionModal` 完全对齐：取该版本快照 → `updateApp` 写回；而
 * `updateApp` 覆盖前会自动快照当前版本，所以**每次恢复本身也都可以再撤销**。
 *
 * 不要求会话身份：模板库是全局资源（与 `wb_assets` 同理），且用户完全可能在新会话里
 * 说「把 XX 模板退回上一版」。审批定级见 agui/approvalRegistry（restore 为写操作 → 'write'）。
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { text } from './shared'
import appStoreManager, { type App, type ParamNode } from '../../appStore'
import { currentAppVersion, getAppVersion, listAppVersions } from '../../appAssets'

/** 模板库默认保留的版本数（与 appAssets 的 MAX_VERSIONS 一致） */
const DEFAULT_LIMIT = 20

/** app_id / id / name 三种定位口径归一（模型实测混用） */
function pickSelector(args: Record<string, unknown>): { key: string; byName: boolean } {
  const idLike = args.app_id ?? args.appId ?? args.id
  if (idLike != null && String(idLike).trim()) return { key: String(idLike).trim(), byName: false }
  const name = args.name ?? args.template_name ?? args.templateName
  return { key: name == null ? '' : String(name).trim(), byName: true }
}

/**
 * 定位目标模板。按名定位时要求**同名唯一**——同名多个属于历史遗留的重复固化，
 * 不猜，明确要求传 app_id（与 wb_publish_workflow 的迭代判定同一口径）。
 */
function resolveApp(args: Record<string, unknown>): { app?: App; error?: string; hint?: string } {
  const { key, byName } = pickSelector(args)
  if (!key) return { error: '需要 app_id（或 id）或 name 来定位模板' }

  if (!byName) {
    // wb_list_templates 下发的 id 带 app: 前缀（模板库命名空间），而版本
    // 历史键控在 appStore 的裸 uuid 上——两种口径都要能解析，否则模型拿
    // 列表 id 查版本必然「未找到模板」（回归测试 R-B2 真机抓到）。
    const app =
      appStoreManager.getAppById(key) ?? appStoreManager.getAppById(key.replace(/^app:/, ''))
    if (!app) return { error: `未找到模板：${key}`, hint: '可用 wb_list_templates 查 id' }
    return { app }
  }

  const sameName = appStoreManager.findAppsByName(key)
  if (sameName.length === 0) {
    return { error: `未找到名为「${key}」的模板`, hint: '可用 wb_list_templates 查看模板库' }
  }
  if (sameName.length > 1) {
    return {
      error: `有 ${sameName.length} 个同名模板「${key}」，无法确定目标`,
      hint: `请改用 app_id 指定：${sameName.map((a) => a.id).join(' / ')}`
    }
  }
  return { app: sameName[0]! }
}

/** 版本快照的摘要视图（够模型判断该退哪一版，不必把整份 workflow 塞进上下文） */
function summarizeSnapshot(
  version: number,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const template = (snapshot.template ?? {}) as {
    prompt?: Record<string, unknown>
    paramsNodes?: ParamNode[]
  }
  const paramsNodes = Array.isArray(template.paramsNodes) ? template.paramsNodes : []
  return {
    version,
    name: (snapshot.name as string | undefined) ?? null,
    description: (snapshot.description as string | undefined) ?? null,
    node_count: template.prompt ? Object.keys(template.prompt).length : 0,
    input_params: paramsNodes.filter((p) => p.category === 'input').map((p) => p.name),
    output_count: paramsNodes.filter((p) => p.category === 'output').length
  }
}

export const versionTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_app_versions',
      description:
        '查看/回滚模板（App）的版本历史。用 wb_publish_workflow 迭代过某个模板后，每次写入都会把上一版自动快照——用本工具可以看到改过几版、每版长什么样，并把模板退回某一版。\n\naction=list 看版本列表（含当前生效版本号）；get 看某一版的摘要（节点数、可填参数名）；restore 把模板退回该版本。restore 之后当前版本也会被快照，所以误退也能再退回来。定位模板传 app_id（推荐，wb_list_templates / wb_publish_workflow 都会返回）或用唯一同名。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'restore'],
            description: 'list=列版本；get=看某版摘要；restore=回滚到某版'
          },
          app_id: {
            type: 'string',
            description: '目标模板 id（推荐）。也可用 id 别名；或改用 name 定位'
          },
          name: {
            type: 'string',
            description: '目标模板名（仅在模板库中同名唯一时可用；同名多个请改用 app_id）'
          },
          version: {
            type: 'number',
            description: 'get / restore 必填：目标版本号（来自 action=list 的列表）'
          },
          limit: { type: 'number', description: `list 返回条数上限（默认 ${DEFAULT_LIMIT}）` }
        },
        required: ['action'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args) => {
      // action 先校验：否则未知 action 会先撞上「缺 version」等分支，
      // 把「你给的动作名不对」误报成参数错误，模型就摸不到允许值了
      const action = String(args.action ?? '').trim()
      const ACTIONS = ['list', 'get', 'restore'] as const
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return text({
          ok: false,
          error: `未知 action：${action || '(空)'}`,
          allowed: [...ACTIONS]
        })
      }

      const resolved = resolveApp(args)
      if (!resolved.app) {
        return text({
          ok: false,
          error: resolved.error,
          ...(resolved.hint ? { hint: resolved.hint } : {})
        })
      }
      const app = resolved.app
      const currentVersion = currentAppVersion(app.id)

      if (action === 'list') {
        const limitRaw = Number(args.limit ?? DEFAULT_LIMIT)
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT
        const versions = listAppVersions(app.id).slice(0, limit)
        return text({
          ok: true,
          app_id: app.id,
          name: app.name,
          // 当前生效版本不在快照表里（表里存的是被替换掉的旧态），单独回报
          current_version: currentVersion,
          count: versions.length,
          versions: versions.map((v) => ({
            version: v.version,
            created_at: v.created_at,
            name: v.name
          })),
          ...(versions.length === 0
            ? { note: '该模板没有任何历史版本（从未被迭代写入过），当前即为第 1 版' }
            : {})
        })
      }

      const versionRaw = args.version
      const version = Number(versionRaw)
      if (versionRaw == null || !Number.isFinite(version) || version <= 0) {
        return text({ ok: false, error: `${action} 需要 version（正整数，取自 action=list）` })
      }

      // 当前生效版本没有快照行——说清楚，避免模型以为数据丢了
      if (version === currentVersion) {
        return text({
          ok: action === 'restore' ? false : true,
          app_id: app.id,
          name: app.name,
          current_version: currentVersion,
          version,
          note: `v${version} 是当前生效版本，快照表里没有它（表里存的是被替换掉的旧版）。${
            action === 'restore' ? '无需恢复。' : ''
          }`
        })
      }

      const snapshot = getAppVersion(app.id, version)
      if (!snapshot) {
        return text({
          ok: false,
          error: `未找到 v${version} 的快照（该模板的历史范围：v1–v${currentVersion - 1}）`,
          hint: '用 action=list 查看可用版本'
        })
      }

      if (action === 'get') {
        return text({
          ok: true,
          app_id: app.id,
          current_version: currentVersion,
          ...summarizeSnapshot(version, snapshot)
        })
      }

      if (action === 'restore') {
        // 只回写可变字段（id/createdAt/updatedAt 由 store 维护，不让快照覆盖）
        const patch: Partial<App> = {}
        if ('name' in snapshot) patch.name = String(snapshot.name)
        if ('description' in snapshot)
          patch.description = snapshot.description as string | undefined
        if ('template' in snapshot) patch.template = snapshot.template as App['template']

        const updated = appStoreManager.updateApp(app.id, patch)
        if (!updated) {
          return text({ ok: false, error: `恢复失败：模板 ${app.id} 不存在或写入被拒` })
        }
        // updateApp 覆盖前已自动快照「恢复前的那一版」→ 本次恢复本身可再撤销
        const newCurrent = currentAppVersion(app.id)
        return text({
          ok: true,
          restored_from: version,
          app_id: app.id,
          name: updated.name,
          previous_version: currentVersion,
          current_version: newCurrent,
          undo_hint: `如误退，可用 action=restore version=${currentVersion} 退回恢复前的状态`
        })
      }

      // action 已在入口校验过，这里只是满足 TS 的完备性要求（运行时不可达）
      return text({ ok: false, error: `未处理的 action：${action}` })
    }
  }
]
