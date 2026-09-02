import { describe, it, expect } from 'vitest'
import {
  paramFieldsFromTemplate,
  makeAppNode,
  collectUpstream,
  imageObjectRef,
  buildNodeOverrides,
  artifactLayout,
  appNodesDigest,
  APP_NODE_W,
  APP_NODE_H,
} from './appNode'

const APP = {
  id: 'app-1',
  name: '文生图',
  template: {
    paramsNodes: [
      {
        id: '6',
        title: '提示词',
        category: 'input',
        type: 'CLIPTextEncode',
        selectedWidget: { name: 'text', type: 'customtext' },
      },
      {
        id: '3',
        title: '步数',
        category: 'input',
        type: 'KSampler',
        selectedWidget: { name: 'steps', type: 'slider', options: { min: 1, max: 50, step: 1 } },
      },
      {
        id: '10',
        title: '参考图',
        category: 'input',
        type: 'LoadImage',
        selectedWidget: { name: 'image', type: 'combo' },
      },
      {
        id: '20',
        title: '出图',
        category: 'output',
        type: 'SaveImage',
        selectedWidget: { name: 'filename_prefix', type: 'string' },
      },
    ],
    prompt: {},
  },
}

describe('paramFieldsFromTemplate', () => {
  it('派生字段并过滤 output', () => {
    const f = paramFieldsFromTemplate(APP)
    expect(f.map((x) => x.nodeId)).toEqual(['6', '3', '10'])
    const [text, steps, img] = f
    expect(text.widget).toBe('text')
    expect(steps.widget).toBe('slider')
    expect(steps.min).toBe(1)
    expect(steps.max).toBe(50)
    expect(img.widget).toBe('image')
    expect(img.nodeType).toBe('LoadImage')
  })
  it('空模板/无 paramsNodes 安全返回 []', () => {
    expect(paramFieldsFromTemplate(null)).toEqual([])
    expect(paramFieldsFromTemplate({ template: {} })).toEqual([])
  })
  it('LoadImage 文件槽：历史模板 selectedWidget.type=string 也识别为 image', () => {
    // 真实模板形状（文生图·文本批量）：type string 而非 combo，按节点类型判定
    const app = {
      template: {
        paramsNodes: [
          {
            id: '1',
            title: 'image',
            category: 'input',
            type: 'LoadImage',
            selectedWidget: { name: 'image', type: 'string' },
          },
        ],
        prompt: { 1: { class_type: 'LoadImage', inputs: { image: 'x.png' } } },
      },
    }
    const fields = paramFieldsFromTemplate(app)
    expect(fields.length).toBe(1)
    expect(fields[0].widget).toBe('image')
    // 喂养：上游 image 物件 → 该槽（filename 引用）
    const { overrides, fedFields } = buildNodeOverrides({ params: {} }, fields, {
      images: [
        {
          id: 'i1',
          type: 'image',
          name: 'ref.png',
          src: 'http://h/view?filename=ref.png&subfolder=&type=output',
        },
      ],
      notes: [],
      apps: [],
      srcIds: ['i1'],
    })
    expect(overrides['1']).toEqual({ image: 'ref.png' })
    expect(fedFields.length).toBe(1)
  })
  it('widget 缺失/无法识别的字段跳过', () => {
    expect(
      paramFieldsFromTemplate({ template: { paramsNodes: [{ id: '1', category: 'input' }] } }),
    ).toEqual([])
  })
})

describe('makeAppNode', () => {
  it('居中放置 + 默认尺寸 + 空参数', () => {
    const n = makeAppNode('app-1', '文生图', 500, 400)
    expect(n.type).toBe('app')
    expect(n.appId).toBe('app-1')
    expect(n.x).toBe(Math.round(500 - APP_NODE_W / 2))
    expect(n.y).toBe(Math.round(400 - APP_NODE_H / 2))
    expect(n.width).toBe(APP_NODE_W)
    expect(n.params).toEqual({})
    expect(n.status).toBe('idle')
    expect(n.id).toMatch(/^a\d+/)
  })
})

describe('collectUpstream', () => {
  const objects = [
    { id: 'img1', type: 'image', x: 0, y: 0, width: 10, height: 10 },
    { id: 'note1', type: 'note', x: 0, y: 0, width: 10, height: 10, text: '一只鲸鱼' },
    { id: 'other', type: 'app', x: 0, y: 0, width: 10, height: 10 },
  ]
  const links = [
    { id: 'l1', from: 'img1', to: 'nodeX' },
    { id: 'l2', from: 'note1', to: 'nodeX' },
    { id: 'l3', from: 'other', to: 'nodeX' },
    { id: 'l4', from: 'img1', to: 'elsewhere' },
  ]
  it('收集直接上游并分类', () => {
    const up = collectUpstream('nodeX', objects, links)
    expect(up.images.map((o) => o.id)).toEqual(['img1'])
    expect(up.notes.map((o) => o.id)).toEqual(['note1'])
    expect(up.apps.map((o) => o.id)).toEqual(['other'])
    expect(up.srcIds).toEqual(['img1', 'note1', 'other'])
  })
  it('无上游返回空', () => {
    const up = collectUpstream('nobody', objects, links)
    expect(up.images).toEqual([])
    expect(up.notes).toEqual([])
  })
})

describe('imageObjectRef', () => {
  it('/view URL 反解 filename/subfolder/type', () => {
    const ref = imageObjectRef({
      type: 'image',
      src: 'http://127.0.0.1:8188/view?filename=ComfyUI_001.png&subfolder=a&type=output',
    })
    expect(ref).toEqual({ filename: 'ComfyUI_001.png', subfolder: 'a', type: 'output' })
  })
  it('blob:/data: 返回 null', () => {
    expect(imageObjectRef({ type: 'image', src: 'blob:http://x/1' })).toBeNull()
    expect(imageObjectRef({ type: 'image', src: 'data:image/png;base64,x' })).toBeNull()
    expect(imageObjectRef({ type: 'note' })).toBeNull()
  })
})

describe('buildNodeOverrides', () => {
  const FIELDS = paramFieldsFromTemplate(APP)
  const UPSTREAM = {
    images: [
      {
        id: 'img1',
        type: 'image',
        name: 'ref.png',
        src: 'http://127.0.0.1:8188/view?filename=ref.png&subfolder=&type=output',
      },
    ],
    notes: [{ id: 'note1', type: 'note', text: '一只鲸鱼' }],
    apps: [],
    srcIds: ['img1', 'note1'],
  }

  it('用户参数优先', () => {
    const node = { params: { 6: { text: '自定义提示词' }, 3: { steps: 30 } } }
    const { overrides, fedFields } = buildNodeOverrides(node, FIELDS, UPSTREAM)
    expect(overrides['6']).toEqual({ text: '自定义提示词' })
    expect(overrides['3']).toEqual({ steps: 30 })
    // 文本/步数被用户值占住；图片槽无用户值仍由上游喂养
    expect(fedFields.some((x) => x.includes('ref.png'))).toBe(true)
    expect(fedFields.some((x) => x.includes('一只鲸鱼') || x.includes('便签'))).toBe(false)
  })

  it('上游喂养：图片→文件槽、便签→文本槽', () => {
    const node = { params: {} }
    const { overrides, fedFields } = buildNodeOverrides(node, FIELDS, UPSTREAM)
    expect(overrides['6']).toEqual({ text: '一只鲸鱼' })
    expect(overrides['10']).toEqual({ image: 'ref.png' })
    expect(fedFields.length).toBe(2)
  })

  it('无上游时空 overrides', () => {
    const { overrides } = buildNodeOverrides({ params: {} }, FIELDS, {
      images: [],
      notes: [],
      apps: [],
      srcIds: [],
    })
    expect(overrides).toEqual({})
  })

  it('上游图无 /view 引用（blob）不喂', () => {
    const { overrides } = buildNodeOverrides({ params: {} }, FIELDS, {
      images: [{ id: 'b1', type: 'image', src: 'blob:http://x/1' }],
      notes: [],
      apps: [],
      srcIds: ['b1'],
    })
    expect(overrides['10']).toBeUndefined()
  })
})

describe('artifactLayout', () => {
  it('节点右侧一列向下排', () => {
    const node = { x: 100, y: 50, width: 300, height: 190 }
    const spots = artifactLayout(node, 3, [260, 200, 260])
    expect(spots[0]).toEqual({ x: 440, y: 50 })
    expect(spots[1].y).toBe(50 + 260 + 16)
    expect(spots[2].y).toBe(50 + 260 + 16 + 200 + 16)
  })
})

describe('appNodesDigest', () => {
  it('app 节点摘要行', () => {
    const d = appNodesDigest([
      {
        id: 'a1',
        type: 'app',
        appId: 'app-1',
        name: '文生图',
        status: 'running',
        params: { 3: { steps: 30 } },
      },
      { id: 'n1', type: 'note', text: 'x' },
      { id: 'a2', type: 'app', appId: 'app-2', name: '', status: 'idle', params: {} },
    ])
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({
      id: 'a1',
      name: '文生图',
      status: 'running',
      params: '3.steps=30',
    })
    expect(d[1].name).toBe('app-2') // 无 name 回落 appId
  })
})
