/**
 * PresetManager 单测（A1刀2）：presets/favorites/memories 三簇清单语义。
 * 依赖注入 fake——repo 用最小内存实现，templateLibrary/skillLibrary 用静态清单。
 */
import { describe, it, expect } from 'vitest'
import { PresetManager } from './presetManager'
import type { SessionStoreRepo } from './sessionStore'
import type { WorkbenchPreset, WorkbenchFavorite } from './sessionTypes'
import type { WorkflowTemplate } from './templateCore'
import type { SkillInfo } from './skillStore'

/** 最小内存 repo（只实现 PresetManager 用到的方法） */
function mkRepo() {
  const state = {
    memories: {} as Record<string, { value: string; updatedAt: number }>,
    favorites: [] as WorkbenchFavorite[],
    presets: [] as WorkbenchPreset[],
    presetDefault: undefined as string | undefined
  }
  return {
    listMemories: () => ({ ...state.memories }),
    upsertMemory: (k: string, v: string) => {
      state.memories[k] = { value: v, updatedAt: Date.now() }
    },
    removeMemory: (k: string) => {
      if (!(k in state.memories)) return false
      delete state.memories[k]
      return true
    },
    listFavorites: () => [...state.favorites],
    findFavorite: (sessionId: string, file: { filename: string; subfolder?: string }) =>
      state.favorites.find(
        (f) =>
          f.sessionId === sessionId &&
          f.file.filename === file.filename &&
          (f.file.subfolder ?? '') === (file.subfolder ?? '')
      ),
    addFavorite: (fav: WorkbenchFavorite) => {
      state.favorites.push(fav)
    },
    removeFavorite: (id: string) => {
      const n = state.favorites.length
      state.favorites = state.favorites.filter((f) => f.id !== id)
      return state.favorites.length !== n
    },
    listUserPresets: () => [...state.presets],
    addUserPreset: (p: WorkbenchPreset) => {
      state.presets.push(p)
    },
    updateUserPreset: (id: string, patch: Partial<WorkbenchPreset>) => {
      const idx = state.presets.findIndex((p) => p.id === id)
      if (idx === -1) return null
      const updated = { ...state.presets[idx]!, ...patch }
      state.presets[idx] = updated
      return updated
    },
    mapUserPresets: (fn: (p: WorkbenchPreset) => WorkbenchPreset) => {
      let changed = 0
      state.presets = state.presets.map((p) => {
        const next = fn(p)
        if (next !== p) changed++
        return next
      })
      return changed
    },
    deleteUserPreset: (id: string) => {
      const n = state.presets.length
      state.presets = state.presets.filter((p) => p.id !== id)
      const ok = state.presets.length < n
      if (state.presetDefault === id) state.presetDefault = undefined
      return ok
    },
    getDefaultPresetId: (fallback: string) => state.presetDefault ?? fallback,
    setDefaultPreset: (id: string) => {
      state.presetDefault = id
    }
  } as unknown as SessionStoreRepo
}

const mkTemplates = (ids: string[]) => ({
  list: () =>
    ids.map(
      (id) =>
        ({
          id,
          name: id,
          description: '',
          prompt: {},
          paramsNodes: [],
          mediaType: 'image'
        }) as unknown as WorkflowTemplate
    )
})

const mkSkills = (names: string[]) => ({
  list: () =>
    names.map(
      (name) =>
        ({
          name,
          description: '',
          builtin: false,
          enabled: true,
          source: 'user',
          order: 0,
          bodyTokens: 0
        }) as unknown as SkillInfo
    )
})

function mkManager(templateIds: string[] = ['t1', 't2'], skillNames: string[] = ['s1']) {
  return new PresetManager({
    repo: mkRepo(),
    templateLibrary: mkTemplates(templateIds),
    skillLibrary: mkSkills(skillNames)
  })
}

describe('PresetManager — memories', () => {
  it('remember 空 key 抛错；正常写入后 renderMemoryContext 注入', () => {
    const m = mkManager()
    expect(() => m.rememberMemory('  ', 'v')).toThrow('memory key')
    m.rememberMemory('风格偏好', '赛博朋克霓虹')
    const ctx = m.renderMemoryContext()
    expect(ctx).toContain('用户长期记忆')
    expect(ctx).toContain('风格偏好: 赛博朋克霓虹')
    expect(m.forgetMemory('风格偏好')).toBe(true)
    expect(m.renderMemoryContext()).toBe('')
  })
})

describe('PresetManager — favorites', () => {
  it('同会话同文件幂等；跨会话不算重复', () => {
    const m = mkManager()
    const file = { filename: 'a.png', subfolder: '' }
    const a1 = m.addFavorite({ sessionId: 's1', executionPromptId: 'p1', templateId: 't1', file })
    const a2 = m.addFavorite({ sessionId: 's1', executionPromptId: 'p2', templateId: 't1', file })
    expect(a2.id).toBe(a1.id) // 幂等返回同一条
    const b = m.addFavorite({ sessionId: 's2', executionPromptId: 'p1', templateId: 't1', file })
    expect(b.id).not.toBe(a1.id)
    expect(m.listFavorites('s1')).toHaveLength(1)
    expect(m.listFavorites()).toHaveLength(2)
  })
})

describe('PresetManager — presets', () => {
  it('create + list 排序（order 升序/缺省 100）；builtin 不可改删', () => {
    const m = mkManager()
    const p = m.createPreset({ id: 'my-preset', name: '我的' })
    expect(p.id).toBe('my-preset')
    const ids = m.listPresets().map((x) => x.id)
    expect(ids).toContain('my-preset')
    expect(ids).toContain('standard') // builtin 在场
    const builtin = m.listPresets().find((x) => x.builtin)
    expect(() => m.updatePresetTemplates(builtin!.id, [])).toThrow('readonly')
    expect(m.deletePreset(builtin!.id)).toBe(false)
  })

  it('updatePresetTemplates 过滤不存在的模板 id', () => {
    const m = mkManager()
    m.createPreset({ id: 'p1', name: 'x' })
    const updated = m.updatePresetTemplates('p1', ['t1', 't2', 'ghost'])
    expect(updated.templateIds).toEqual(['t1', 't2'])
    expect(() => m.updatePresetTemplates('nope', [])).toThrow('not found')
  })

  it('fixPresetSkillRefs 改名修引用；default 回退 builtin 首项', () => {
    const m = mkManager([], ['old-skill'])
    m.createPreset({ id: 'p1', name: 'x' })
    m.updatePresetSkills('p1', ['old-skill', 'ghost-skill'])
    const changed = m.fixPresetSkillRefs('old-skill', 'new-skill')
    expect(changed).toBe(1)
    expect(m.getPreset('p1')?.skillIds).toEqual(['new-skill'])
    // default 未设置 → builtin 首项
    expect(m.getDefaultPresetId()).toBeTruthy()
    expect(m.setDefaultPreset('p1')).toBe(true)
    expect(m.getDefaultPresetId()).toBe('p1')
    // 删除 default → 回退
    m.deletePreset('p1')
    expect(m.getDefaultPresetId()).not.toBe('p1')
  })
})
