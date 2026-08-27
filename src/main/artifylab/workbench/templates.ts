/**
 * 工作台模板库（workbench-plan.md §3）。
 *
 * 双源聚合（纯转换在 templateCore.ts，此处是带缓存/事件的单例层）：
 * - builtin:*  —— 内置种子（后续版本精选 Comfy-Org/workflow_templates (MIT) 填充）
 * - app:*      —— 用户 app 工作流实时同步（appStore change 事件驱动清缓存）
 *
 * 模板 = 可执行子集：prompt（API 格式）+ paramsNodes（参数 schema）。
 * toPseudoApp() 包装后零改造复用 executor.executeApp 的 seed/上传/合并/提交链路。
 */
import { EventEmitter } from 'events'
import appStoreManager from '../appStore'
import { logger } from '../utils/logger'
import { templateFromApp, type WorkflowTemplate, type WorkbenchMediaType } from './templateCore'

export type { WorkflowTemplate, WorkbenchMediaType }
export { templateFromApp, toPseudoApp, inferMediaType, extractRequiredModels } from './templateCore'

/** 内置种子：MVP 为空，后续从官方模板库（MIT）精选填充。结构先立好。 */
const BUILTIN_TEMPLATES: WorkflowTemplate[] = []

/**
 * 模板库（单例语义）：list()/get() 即时聚合，appStore change 时清缓存并广播。
 * 不常驻内存副本（app 数量级小，聚合 O(n) 足够，避免状态漂移）。
 */
class TemplateLibrary extends EventEmitter {
  private cache: WorkflowTemplate[] | null = null

  constructor() {
    super()
    appStoreManager.on('change', () => {
      this.cache = null
      this.emit('change')
    })
  }

  list(): WorkflowTemplate[] {
    if (!this.cache) {
      const fromApps = appStoreManager
        .getAllApps()
        .map(templateFromApp)
        .filter((t): t is WorkflowTemplate => t !== null)
      this.cache = [...BUILTIN_TEMPLATES, ...fromApps]
    }
    return this.cache
  }

  get(id: string): WorkflowTemplate | null {
    return this.list().find((t) => t.id === id) ?? null
  }

  /** 供内置模板注册（后续精选官方库填充时使用） */
  registerBuiltin(t: WorkflowTemplate): void {
    if (BUILTIN_TEMPLATES.some((b) => b.id === t.id)) return
    BUILTIN_TEMPLATES.push(t)
    this.cache = null
    this.emit('change')
  }
}

export const templateLibrary = new TemplateLibrary()

/** 给 codex 的模板清单（裁剪 prompt 全文，只留决策所需元数据） */
export function describeTemplatesForAgent(
  templates: WorkflowTemplate[]
): Array<Record<string, unknown>> {
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    mediaType: t.mediaType,
    chainable: t.chainable ?? false,
    knowledge: t.knowledge ?? null,
    params: t.paramsNodes
      .filter((n) => n.category === 'input')
      .map((n) => ({
        name: n.name,
        type: n.selectedWidget?.type ?? n.type,
        widget: n.selectedWidget?.name,
        options: n.selectedWidget?.options ?? null,
        description: n.description ?? null
      }))
  }))
}

logger.debug('workbench template library initialized')
