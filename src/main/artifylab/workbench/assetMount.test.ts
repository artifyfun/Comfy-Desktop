/**
 * 创作资产 → 模板参数挂载测试（对标建议 #4 执行侧）。
 *
 * 关注点：参考图按序落素材槽、用户显式参数永不被覆盖、seed 只在模板有
 * seed 参数且未被占用时写入、资产 params 合并优先级（用户 > 资产 > 模板默认）、
 * 槽位不足/缺槽时的 issue 而非抛错。
 */
import { describe, expect, it } from 'vitest'
import { listMediaSlots, mountAssetsToTemplate } from './assetMount'
import type { CreativeAsset } from './assetsStore'

type Tpl = Parameters<typeof mountAssetsToTemplate>[0]

function tpl(nodes: Array<Record<string, unknown>>): Tpl {
  return { paramsNodes: nodes } as never as Tpl
}

/** 角色一致性常见的两图槽模板 */
const twoImageTemplate = tpl([
  { id: '1', name: 'image1', category: 'input', renderComponent: 'image-uploader' },
  { id: '2', name: 'image2', category: 'input', renderComponent: 'image-uploader' },
  { id: '3', name: 'seed', category: 'input', renderComponent: 'number' },
  { id: '4', name: 'prompt', category: 'input', renderComponent: 'textarea' },
  { id: '9', name: 'out', category: 'output', renderComponent: 'image-preview' }
])

function asset(patch: Partial<CreativeAsset> & { id: string; name: string }): CreativeAsset {
  return {
    kind: 'character',
    refs: [],
    params: {},
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...patch
  } as CreativeAsset
}

describe('listMediaSlots', () => {
  it('只收 input 且 rc 以 -uploader 结尾的参数，并推断类型', () => {
    const slots = listMediaSlots(tpl([
      { id: '1', name: 'a', category: 'input', renderComponent: 'image-uploader' },
      { id: '2', name: 'b', category: 'input', renderComponent: 'video-uploader' },
      { id: '3', name: 'c', category: 'input', renderComponent: 'audio-uploader' },
      { id: '4', name: 'd', category: 'input', renderComponent: 'textarea' },
      { id: '5', name: 'e', category: 'output', renderComponent: 'image-uploader' }
    ]))
    expect(slots).toEqual([
      { name: 'a', kind: 'image' },
      { name: 'b', kind: 'video' },
      { name: 'c', kind: 'audio' }
    ])
  })
})

describe('参考图挂载', () => {
  it('单资产多参考图按序落槽', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: ['face.png', 'body.png'] })],
      {}
    )
    expect(r.params.image1).toBe('face.png')
    expect(r.params.image2).toBe('body.png')
    expect(r.applied[0]!.slots).toEqual(['image1', 'image2'])
    expect(r.issues).toEqual([])
  })

  it('多资产按传入顺序排队占槽（前者先占）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [
        asset({ id: 'a1', name: '小美', refs: ['m.png'] }),
        asset({ id: 'a2', name: '小刚', refs: ['g.png'] })
      ],
      {}
    )
    expect(r.params.image1).toBe('m.png')
    expect(r.params.image2).toBe('g.png')
    expect(r.applied.map((a) => a.slots[0])).toEqual(['image1', 'image2'])
  })

  it('用户/模型已显式填的槽不被覆盖：参考图顺位填剩余槽（保持 refs 相对顺序）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: ['face.png', 'body.png'] })],
      { image1: 'user-choice.png' }
    )
    // 用户占 image1 → 资产主参考图顺位落到 image2（不丢主参考），剩余参考图报 issue
    expect(r.params.image1).toBe('user-choice.png')
    expect(r.params.image2).toBe('face.png')
    expect(r.applied[0]!.slots).toEqual(['image2'])
    expect(r.issues.some((s) => s.includes('body.png'))).toBe(true)
  })

  it('参考图多于可用槽：挂满即止并给 issue（不抛错）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: ['1.png', '2.png', '3.png'] })],
      {}
    )
    expect(r.applied[0]!.slots.length).toBe(2)
    expect(r.issues.some((s) => s.includes('没有可用素材槽'))).toBe(true)
  })

  it('模板无图片槽 → issue 指明原因', () => {
    const r = mountAssetsToTemplate(
      tpl([{ id: '1', name: 'seed', category: 'input', renderComponent: 'number' }]),
      [asset({ id: 'a1', name: '小美', refs: ['x.png'] })],
      {}
    )
    expect(r.applied[0]!.slots).toEqual([])
    expect(r.issues.some((s) => s.includes('没有图片素材槽'))).toBe(true)
  })

  it('video 槽可吃图片（VHS 类工作流常见）', () => {
    const r = mountAssetsToTemplate(
      tpl([{ id: '1', name: 'frame', category: 'input', renderComponent: 'video-uploader' }]),
      [asset({ id: 'a1', name: '首帧', refs: ['first.png'] })],
      {}
    )
    expect(r.params.frame).toBe('first.png')
  })

  it('ref 可带类型前缀显式指定槽型（"video:x.mp4" 优先级高于宽容序）', () => {
    const r = mountAssetsToTemplate(
      tpl([
        { id: '1', name: 'img', category: 'input', renderComponent: 'image-uploader' },
        { id: '2', name: 'vid', category: 'input', renderComponent: 'video-uploader' }
      ]),
      [asset({ id: 'a1', name: '片段', refs: ['video:clip.mp4'] })],
      {}
    )
    expect(r.params.vid).toBe('clip.mp4')
    expect(r.params.img).toBeUndefined()
  })

  it('空 refs 的资产不占槽，只走 seed/params', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '风格', refs: [], seed: 42 })],
      {}
    )
    expect(r.params.image1).toBeUndefined()
    expect(r.params.seed).toBe(42)
    expect(r.applied[0]!.slots).toEqual([])
  })
})

describe('seed 挂载', () => {
  it('模板有 seed 参数且未被占用 → 写入资产 seed', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: [], seed: 12345 })],
      {}
    )
    expect(r.params.seed).toBe(12345)
    expect(r.applied[0]!.seedApplied).toBe(12345)
    expect(r.issues).toEqual([])
  })

  it('seed 已被用户指定 → 保留用户值并给 issue 说明', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: [], seed: 12345 })],
      { seed: 999 }
    )
    expect(r.params.seed).toBe(999)
    expect(r.applied[0]!.seedApplied).toBeUndefined()
    expect(r.issues.some((s) => s.includes('未写入'))).toBe(true)
  })

  it('模板无 seed 参数 → 静默不写（不产生噪音 issue）', () => {
    const r = mountAssetsToTemplate(
      tpl([{ id: '1', name: 'prompt', category: 'input', renderComponent: 'textarea' }]),
      [asset({ id: 'a1', name: '小美', refs: [], seed: 7 })],
      {}
    )
    expect('seed' in r.params).toBe(false)
    expect(r.issues).toEqual([])
  })

  it('多资产都有 seed → 首个写入，后续不覆盖', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [
        asset({ id: 'a1', name: 'A', refs: [], seed: 1 }),
        asset({ id: 'a2', name: 'B', refs: [], seed: 2 })
      ],
      {}
    )
    expect(r.params.seed).toBe(1)
    expect(r.applied[0]!.seedApplied).toBe(1)
    expect(r.applied[1]!.seedApplied).toBeUndefined()
    expect(r.issues.some((s) => s.includes('未写入'))).toBe(true)
  })
})

describe('params 合并优先级', () => {
  it('资产 params 并进参数（LoRA 触发词场景）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: [], params: { lora: 'xiaomei_v3', strength: 0.8 } })],
      {}
    )
    expect(r.params.lora).toBe('xiaomei_v3')
    expect(r.params.strength).toBe(0.8)
    expect(r.applied[0]!.paramsApplied.sort()).toEqual(['lora', 'strength'])
  })

  it('用户显式参数最高优先级（资产不覆盖）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a1', name: '小美', refs: [], params: { strength: 0.8, lora: 'a' } })],
      { strength: 0.5 }
    )
    expect(r.params.strength).toBe(0.5)
    expect(r.params.lora).toBe('a')
    expect(r.applied[0]!.paramsApplied).toEqual(['lora'])
  })

  it('多资产 params 后者覆盖前者（叠加式组合）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [
        asset({ id: 'a1', name: 'A', refs: [], params: { style: 'anime', steps: 20 } }),
        asset({ id: 'a2', name: 'B', refs: [], params: { steps: 30 } })
      ],
      {}
    )
    expect(r.params.style).toBe('anime')
    expect(r.params.steps).toBe(30)
  })
})

describe('边界', () => {
  it('空资产列表 → 参数原样返回（浅拷贝，不共享引用）', () => {
    const user = { prompt: 'hi' }
    const r = mountAssetsToTemplate(twoImageTemplate, [], user)
    expect(r.params).toEqual({ prompt: 'hi' })
    expect(r.params).not.toBe(user)
  })

  it('不修改传入的 userParams 对象', () => {
    const user = { prompt: 'hi' }
    mountAssetsToTemplate(twoImageTemplate, [asset({ id: 'a', name: 'x', refs: ['r.png'] })], user)
    expect(user).toEqual({ prompt: 'hi' })
  })

  it('空字符串/空白参数视为未填（资产可正常挂载）', () => {
    const r = mountAssetsToTemplate(
      twoImageTemplate,
      [asset({ id: 'a', name: 'x', refs: ['r.png'] })],
      { image1: '   ' }
    )
    expect(r.params.image1).toBe('r.png')
  })
})
