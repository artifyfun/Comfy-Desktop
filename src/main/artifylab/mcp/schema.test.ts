import { describe, it, expect } from 'vitest'
import { buildAppToolInputSchema } from './schema'
import type { ParamNode } from '../appStore'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schemaProps = (nodes: ParamNode[]): Record<string, any> =>
  (buildAppToolInputSchema(nodes) as { properties: Record<string, any> }).properties

describe('buildAppToolInputSchema', () => {
  it('textarea → string', () => {
    const node: ParamNode = {
      id: 1,
      category: 'input',
      type: 'CLIPTextEncode',
      name: 'prompt',
      renderComponent: 'textarea',
      selectedWidget: { name: 'text', type: 'string' }
    }
    expect(schemaProps([node]).prompt.type).toBe('string')
  })

  it('slider → number with min/max/step', () => {
    const node: ParamNode = {
      id: 2,
      category: 'input',
      type: 'KSampler',
      name: 'cfg',
      renderComponent: 'slider',
      selectedWidget: { name: 'cfg', type: 'slider', options: { min: 0, max: 20, step: 0.5 } }
    }
    expect(schemaProps([node]).cfg).toMatchObject({ type: 'number', minimum: 0, maximum: 20, multipleOf: 0.5 })
  })

  it('select → string enum from widget options', () => {
    const node: ParamNode = {
      id: 3,
      category: 'input',
      type: 'X',
      name: 'model',
      renderComponent: 'select',
      selectedWidget: { name: 'model', type: 'combo', options: { values: ['a', 'b'] } }
    }
    expect(schemaProps([node]).model).toMatchObject({ type: 'string', enum: ['a', 'b'] })
  })

  it('image-uploader → string', () => {
    const node: ParamNode = {
      id: 4,
      category: 'input',
      type: 'LoadImage',
      name: 'img',
      renderComponent: 'image-uploader'
    }
    expect(schemaProps([node]).img.type).toBe('string')
  })

  it('注入公共参数 seed / randomize_seed(默认 true)', () => {
    const props = schemaProps([])
    expect(props.seed).toBeDefined()
    expect(props.randomize_seed).toMatchObject({ type: 'boolean', default: true })
  })

  it('output 节点不进入 inputSchema', () => {
    const out: ParamNode = { id: 5, category: 'output', type: 'SaveImage', name: 'result' }
    expect(schemaProps([out]).result).toBeUndefined()
  })
})
