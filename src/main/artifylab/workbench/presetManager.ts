/**
 * PresetManager —— 预设/收藏/长期记忆的清单类职责（A1刀2）。
 *
 * 从 WorkbenchService 上帝对象拆出的第一个深 module：三簇「读列表 + 增改删 +
 * 落盘」语义完全同构，全部经 SessionStoreRepo 显式方法（A1刀1 收编后），
 * 不再穿墙。service 保留同签名转发（调用方零改动），后续路由层可逐步
 * 直连本 module。
 *
 * 依赖注入：templateLibrary/skillLibrary 由 service 组合根传入（测试可换 fake）。
 */
import { randomUUID } from 'node:crypto'
import type { WorkbenchPreset, WorkbenchFavorite, WorkbenchOutputFile } from './sessionTypes'
import { BUILTIN_PRESETS, clonePreset } from './presetCore'
import type { SessionStoreRepo } from './sessionStore'
import type { SkillInfo } from './skillStore'
import type { WorkflowTemplate } from './templateCore'

export interface PresetManagerDeps {
  repo: SessionStoreRepo
  /** 模板存在性校验（updatePresetTemplates 只保留真实存在的 id） */
  templateLibrary: { list(): WorkflowTemplate[] }
  /** 技能存在性校验（updatePresetSkills / fixPresetSkillRefs） */
  skillLibrary: { list(): SkillInfo[] }
}

export class PresetManager {
  constructor(private readonly deps: PresetManagerDeps) {}

  // ---------------- 长期记忆（dsh memory 语义） ----------------

  listMemories(): Record<string, { value: string; updatedAt: number }> {
    return this.deps.repo.listMemories()
  }

  /** 写入/更新（幂等，同 key 覆盖）；key 截断 64、value 截断 500 */
  rememberMemory(key: string, value: string): void {
    const k = key.trim().slice(0, 64)
    if (!k) throw new Error('memory key 不能为空')
    this.deps.repo.upsertMemory(k, value.trim().slice(0, 500))
  }

  forgetMemory(key: string): boolean {
    return this.deps.repo.removeMemory(key)
  }

  /** decide spec 的「用户长期记忆」注入段（空记忆返回空串） */
  renderMemoryContext(): string {
    const entries = Object.entries(this.deps.repo.listMemories())
    if (entries.length === 0) return ''
    const lines = entries
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 20)
      .map(([k, v]) => `- ${k}: ${v.value}`)
    return `\n## 用户长期记忆（跨会话持久,可直接引用;需更新时用 intent=memory）\n${lines.join('\n')}`
  }

  // ---------------- 收藏（产物收藏夹，跨会话） ----------------

  listFavorites(sessionId?: string): WorkbenchFavorite[] {
    const all = this.deps.repo.listFavorites()
    return sessionId ? all.filter((f) => f.sessionId === sessionId) : all
  }

  addFavorite(input: {
    sessionId: string
    executionPromptId: string
    templateId: string
    file: WorkbenchOutputFile
    note?: string
  }): WorkbenchFavorite {
    const fav: WorkbenchFavorite = {
      id: randomUUID(),
      sessionId: input.sessionId,
      promptId: input.executionPromptId,
      templateId: input.templateId,
      file: input.file,
      note: input.note,
      createdAt: Date.now()
    }
    // 去重：同会话同文件重复收藏视为幂等
    const dup = this.deps.repo.findFavorite(fav.sessionId, fav.file)
    if (dup) return dup
    this.deps.repo.addFavorite(fav)
    return fav
  }

  removeFavorite(id: string): boolean {
    return this.deps.repo.removeFavorite(id)
  }

  // ---------------- 预设 CRUD（copy-dialog 语义） ----------------

  listPresets(): WorkbenchPreset[] {
    // dsh preset.yml order 语义：按 order 升序，缺省排 100
    return [...BUILTIN_PRESETS, ...this.deps.repo.listUserPresets()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100)
    )
  }

  getPreset(id: string): WorkbenchPreset | null {
    return this.listPresets().find((p) => p.id === id) ?? null
  }

  createPreset(opts: { from?: string; id: string; name?: string }): WorkbenchPreset {
    const existing = new Set(this.listPresets().map((p) => p.id))
    const preset = clonePreset(opts.from ?? 'standard', opts.id, opts.name ?? '', existing)
    if (!preset) throw new Error('预设 id 非法或已存在')
    this.deps.repo.addUserPreset(preset)
    return preset
  }

  /** 预设捆绑模板（可执行推荐池）。内置预设不可改。 */
  updatePresetTemplates(id: string, templateIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const valid = new Set(this.deps.templateLibrary.list().map((t) => t.id))
    const next = [...new Set(templateIds)].filter((s) => valid.has(s))
    const updated = this.deps.repo.updateUserPreset(id, { templateIds: next })
    if (!updated) throw new Error(`preset not found: ${id}`)
    return updated
  }

  /** 预设捆绑技能（SKILL.md name 清单）。内置预设不可改。 */
  updatePresetSkills(id: string, skillIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const valid = new Set(this.deps.skillLibrary.list().map((s) => s.name))
    const next = [...new Set(skillIds)].filter((s) => valid.has(s))
    const updated = this.deps.repo.updateUserPreset(id, { skillIds: next })
    if (!updated) throw new Error(`preset not found: ${id}`)
    return updated
  }

  /** 技能改名后修正所有预设的捆绑引用（改名不失效） */
  fixPresetSkillRefs(oldName: string, newName: string): number {
    return this.deps.repo.mapUserPresets((p) => {
      if (!p.skillIds?.includes(oldName)) return p
      return { ...p, skillIds: p.skillIds.map((s) => (s === oldName ? newName : s)) }
    })
  }

  deletePreset(id: string): boolean {
    // 内置不可删（dsh 同款：shipped preset 不归用户管理）
    if (BUILTIN_PRESETS.some((p) => p.id === id)) return false
    return this.deps.repo.deleteUserPreset(id)
  }

  setDefaultPreset(id: string): boolean {
    if (!this.listPresets().some((p) => p.id === id)) return false
    this.deps.repo.setDefaultPreset(id)
    return true
  }

  getDefaultPresetId(): string {
    return this.deps.repo.getDefaultPresetId(BUILTIN_PRESETS[0]!.id)
  }
}
