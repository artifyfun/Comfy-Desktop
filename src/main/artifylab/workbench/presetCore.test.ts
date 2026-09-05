import { describe, it, expect } from 'vitest'
import {
  BUILTIN_PRESETS,
  UNIVERSAL_SKILL_IDS,
  applyPromptTemplate,
  assignAttachmentsToSlots,
  attachmentSummary,
  clonePreset,
  deriveAttachmentKind,
  isValidPresetId,
  mergeUniversalSkills,
  parseSlashToken,
  presetConstraintText
} from './presetCore'

describe('presetCore', () => {
  describe('内置预设', () => {
    it('5 个内置，standard 无约束', () => {
      expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual([
        'standard',
        'text-to-image',
        'image-to-image',
        'video-gen',
        'omni'
      ])
      expect(BUILTIN_PRESETS[0]!.builtin).toBe(true)
      expect(BUILTIN_PRESETS[0]!.intentHint).toBeUndefined()
    })

    it('意图约束各自正确', () => {
      expect(BUILTIN_PRESETS[1]!.intentHint).toBe('image')
      expect(BUILTIN_PRESETS[3]!.intentHint).toBe('video')
    })
  })

  describe('通用技能层', () => {
    it('UNIVERSAL_SKILL_IDS 覆盖 wb-* core + ops + 提示词工程', () => {
      expect(UNIVERSAL_SKILL_IDS).toContain('wb-orchestration')
      expect(UNIVERSAL_SKILL_IDS).toContain('wb-model-knowledge')
      expect(UNIVERSAL_SKILL_IDS).toContain('prompt-engineering')
      expect(UNIVERSAL_SKILL_IDS).toContain('troubleshooting')
    })

    it('mergeUniversalSkills 通用在前并去重', () => {
      expect(mergeUniversalSkills()).toEqual([...UNIVERSAL_SKILL_IDS])
      expect(mergeUniversalSkills(undefined)).toEqual([...UNIVERSAL_SKILL_IDS])
      const merged = mergeUniversalSkills(['prompt-engineering', 'my-style'])
      expect(merged.filter((id) => id === 'prompt-engineering')).toHaveLength(1)
      expect(merged[0]).toBe(UNIVERSAL_SKILL_IDS[0])
      expect(merged[merged.length - 1]).toBe('my-style')
    })

    it('无 skillIds 的预设（standard）也附带通用技能偏好', () => {
      const standard = BUILTIN_PRESETS.find((p) => p.id === 'standard')!
      const s = presetConstraintText(standard)
      expect(s).toContain('prefer skills [')
      for (const id of UNIVERSAL_SKILL_IDS) expect(s).toContain(id)
    })

    it('领域技能与通用技能合并注入且不重复', () => {
      const t2i = BUILTIN_PRESETS.find((p) => p.id === 'text-to-image')!
      const s = presetConstraintText(t2i)
      expect(s).toContain('krea2-txt2img')
      expect(s).toContain('prompt-engineering')
      const list = s.match(/prefer skills \[([^\]]+)\]/)![1]!.split(', ')
      expect(new Set(list).size).toBe(list.length)
      expect(list.slice(0, UNIVERSAL_SKILL_IDS.length)).toEqual([...UNIVERSAL_SKILL_IDS])
    })
  })

  describe('全能预设 omni', () => {
    const omni = BUILTIN_PRESETS.find((p) => p.id === 'omni')!
    it('不锁意图，领域代表技能齐备', () => {
      expect(omni.builtin).toBe(true)
      expect(omni.intentHint).toBeUndefined()
      expect(omni.skillIds).toContain('krea2-txt2img')
      expect(omni.skillIds).toContain('minimax-h3-video')
      expect(omni.skillIds).toContain('director')
      // 存储列表只含领域技能，通用层靠约束合并，不在存储里重复
      for (const id of UNIVERSAL_SKILL_IDS) expect(omni.skillIds).not.toContain(id)
    })
    it('约束文本包含通用层 + 领域技能', () => {
      const s = presetConstraintText(omni)
      expect(s).toContain('wb-orchestration')
      expect(s).toContain('krea2-txt2img')
    })
  })

  describe('isValidPresetId', () => {
    it('合法 id', () => {
      expect(isValidPresetId('my-preset')).toBe(true)
      expect(isValidPresetId('t2i2')).toBe(true)
    })
    it('非法 id', () => {
      expect(isValidPresetId('My')).toBe(false)
      expect(isValidPresetId('-x')).toBe(false)
      expect(isValidPresetId('a b')).toBe(false)
      expect(isValidPresetId('')).toBe(false)
    })
  })

  describe('clonePreset', () => {
    const ids = new Set(['standard'])
    it('内置预设带 order 排序值（dsh preset.yml 语义）', () => {
      const orders = BUILTIN_PRESETS.map((p) => p.order)
      expect(orders).toEqual([1, 2, 3, 4, 5])
    })
    it('复制内置生成自定义', () => {
      const p = clonePreset('text-to-image', 'my-t2i', '我的文生图', ids)
      expect(p).not.toBeNull()
      expect(p!.id).toBe('my-t2i')
      expect(p!.builtin).toBe(false)
      expect(p!.intentHint).toBe('image') // 继承约束
      expect(p!.name.zh).toBe('我的文生图')
      expect(p!.order).toBe(2.5) // 紧跟源预设之后（dsh order 语义）
    })
    it('id 冲突/非法/未知源返回 null', () => {
      expect(clonePreset('text-to-image', 'standard', 'x', ids)).toBeNull()
      expect(clonePreset('text-to-image', 'BAD', 'x', ids)).toBeNull()
      expect(clonePreset('nope', 'ok-id', 'x', ids)).not.toBeNull() // 未知源落 standard
    })
  })

  describe('applyPromptTemplate', () => {
    it('展开 {input} 占位', () => {
      const preset = {
        promptTemplate: '以我上传的图片为参考：{input}',
        name: { zh: '', en: '' },
        description: { zh: '', en: '' },
        id: 'x',
        builtin: true
      }
      expect(applyPromptTemplate(preset, '改成水彩风')).toBe('以我上传的图片为参考：改成水彩风')
    })
    it('多处占位全部展开', () => {
      const preset = {
        promptTemplate: '{input} 和 {input}',
        name: { zh: '', en: '' },
        description: { zh: '', en: '' },
        id: 'x',
        builtin: true
      }
      expect(applyPromptTemplate(preset, 'A')).toBe('A 和 A')
    })
    it('无模板原样返回', () => {
      expect(applyPromptTemplate(undefined, '一只猫')).toBe('一只猫')
      const noTpl = {
        name: { zh: '', en: '' },
        description: { zh: '', en: '' },
        id: 'x',
        builtin: true
      }
      expect(applyPromptTemplate(noTpl, '一只猫')).toBe('一只猫')
    })
  })

  describe('presetConstraintText', () => {
    it('无预设返回空', () => {
      expect(presetConstraintText(undefined)).toBe('')
    })
    it('组装约束段', () => {
      const p = {
        id: 't2i',
        builtin: true,
        name: { zh: '', en: '' },
        description: { zh: '', en: '' },
        intentHint: 'image' as const,
        preferredTemplateId: 'app:flux',
        defaultParams: { steps: 30 }
      }
      const s = presetConstraintText(p)
      expect(s).toContain('intent MUST be "image"')
      expect(s).toContain('app:flux')
      expect(s).toContain('steps')
    })
    it('捆绑模板与技能分别注入软约束', () => {
      const p = {
        id: 't',
        builtin: false,
        name: { zh: '', en: '' },
        description: { zh: '', en: '' },
        templateIds: ['app:flux'],
        skillIds: ['my-style']
      }
      const s = presetConstraintText(p)
      expect(s).toContain('prefer templates [app:flux] when suitable')
      // 通用技能层并入在前，领域技能追加在后
      expect(s).toContain('my-style] when suitable')
      expect(s).toContain('(read the SKILL.md first)')
    })
  })

  describe('parseSlashToken', () => {
    const presets = [{ id: 't2i' }, { id: 'video-gen' }]
    const templates = [{ id: 'app:flux' }]
    it('预设不参与斜杠（点击选择，dsh 模式）', () => {
      // /t2i 是预设 id，但现在斜杠只匹配技能（模板）；预设 id 的 token 不命中
      expect(parseSlashToken('/t2i 一只猫', presets, templates)).toBeNull()
      expect(parseSlashToken('帮我 /video-gen 做个视频', presets, templates)).toBeNull()
    })
    it('模板快捷方式命中（技能）', () => {
      expect(parseSlashToken('/app:flux 猫', presets, templates)).toEqual({
        id: 'app:flux',
        kind: 'template',
        rest: '猫'
      })
    })
    it('大小写不敏感', () => {
      expect(parseSlashToken('/APP:FLUX 猫', presets, templates)?.id).toBe('app:flux')
    })
    it('未知 token / 非分界（如 url 路径）不命中', () => {
      expect(parseSlashToken('看 http://x.com/flux 这个', presets, templates)).toBeNull()
      expect(parseSlashToken('/unknown 猫', presets, templates)).toBeNull()
    })
  })

  describe('deriveAttachmentKind', () => {
    it('mime 优先', () => {
      expect(deriveAttachmentKind('x.bin', 'video/mp4')).toBe('video')
      expect(deriveAttachmentKind('x.bin', 'audio/ogg')).toBe('audio')
    })
    it('扩展名兜底', () => {
      expect(deriveAttachmentKind('a.png')).toBe('image')
      expect(deriveAttachmentKind('a.MOV')).toBe('video')
      expect(deriveAttachmentKind('a.mp3')).toBe('audio')
      expect(deriveAttachmentKind('a.xyz')).toBe('file')
    })
  })

  describe('attachmentSummary', () => {
    it('空返回空串', () => {
      expect(attachmentSummary([])).toBe('')
    })
    it('多素材计数 + 文件名', () => {
      const s = attachmentSummary([
        { name: 'i1', kind: 'image', filename: 'i1.png', size: 1 },
        { name: 'i2', kind: 'image', filename: 'i2.png', size: 1 },
        { name: 'v1', kind: 'video', filename: 'v1.mp4', size: 1 }
      ])
      expect(s).toContain('2 images')
      expect(s).toContain('1 video')
      expect(s).toContain('i1.png')
    })
  })

  describe('assignAttachmentsToSlots', () => {
    const img = (n: string) => ({ name: n, kind: 'image' as const, filename: n, size: 1 })
    const vid = (n: string) => ({ name: n, kind: 'video' as const, filename: n, size: 1 })
    it('按序分配同类型', () => {
      const { assignments, ignored } = assignAttachmentsToSlots(
        [img('a'), img('b')],
        [
          { param: 'image1', accept: ['image'] },
          { param: 'image2', accept: ['image'] }
        ]
      )
      expect(assignments.map((x) => [x.slot.param, x.attachment.name])).toEqual([
        ['image1', 'a'],
        ['image2', 'b']
      ])
      expect(ignored).toHaveLength(0)
    })
    it('类型不匹配的输入位跳过', () => {
      const { assignments } = assignAttachmentsToSlots(
        [vid('v')],
        [{ param: 'image1', accept: ['image'] }]
      )
      expect(assignments).toHaveLength(0)
    })
    it('多类型输入位（image+video）优先消耗顺序在前附件', () => {
      const { assignments } = assignAttachmentsToSlots(
        [img('a'), vid('v')],
        [{ param: 'media', accept: ['image', 'video'] }]
      )
      expect(assignments[0]?.attachment.name).toBe('a')
    })
    it('多余附件进 ignored', () => {
      const { ignored } = assignAttachmentsToSlots(
        [img('a'), img('b'), img('c')],
        [{ param: 'image1', accept: ['image'] }]
      )
      expect(ignored.map((x) => x.name)).toEqual(['b', 'c'])
    })
    it('类型交错按输入位顺序消耗', () => {
      const { assignments } = assignAttachmentsToSlots(
        [img('a'), vid('v')],
        [
          { param: 'video', accept: ['video'] },
          { param: 'image', accept: ['image'] }
        ]
      )
      expect(assignments.map((x) => [x.slot.param, x.attachment.name])).toEqual([
        ['video', 'v'],
        ['image', 'a']
      ])
    })
  })
})

describe('clonePreset 深拷贝', () => {
  it('副本的 skillIds/templateIds/defaultParams 与 BUILTIN_PRESETS 不共享引用', () => {
    const src = BUILTIN_PRESETS.find((p) => (p.skillIds?.length ?? 0) > 0) ?? BUILTIN_PRESETS[0]!
    const copy = clonePreset(src.id, 'my-copy', '我的副本', new Set())
    expect(copy).not.toBeNull()
    expect(copy!.skillIds).toEqual(src.skillIds ?? [])
    copy!.skillIds!.push('polluted')
    copy!.templateIds!.push('polluted-t')
    ;(copy!.defaultParams as Record<string, unknown>).polluted = true
    copy!.name.zh = '篡改'
    expect(src.skillIds).toEqual(BUILTIN_PRESETS.find((p) => p.id === src.id)!.skillIds)
    expect(src.templateIds).toEqual(BUILTIN_PRESETS.find((p) => p.id === src.id)!.templateIds)
    expect(src.defaultParams).toEqual(BUILTIN_PRESETS.find((p) => p.id === src.id)!.defaultParams)
    expect(src.name.zh).not.toBe('篡改')
  })
})
