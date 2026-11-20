import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readExtraMcpServers, extraMcpTomlLines } from './extraMcp'

describe('extraMcp（stdio 反向桥配置）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wb-extra-mcp-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    delete process.env.EXTRA_MCP_FILE
  })

  it('文件缺失 → 空数组（不抛错）', async () => {
    const out = await readExtraMcpServers(path.join(dir, 'extra-mcp.json'))
    expect(out).toEqual([])
  })

  it('合法清单 → 解析 name/command/args/env', async () => {
    const file = path.join(dir, 'extra-mcp.json')
    await writeFile(
      file,
      JSON.stringify([
        {
          name: 'blender',
          command: 'uvx',
          args: ['blender-mcp'],
          env: { BLENDER_HOST: '127.0.0.1' }
        }
      ])
    )
    process.env.EXTRA_MCP_FILE = file
    const out = await readExtraMcpServers('ignored-when-env-set')
    expect(out).toEqual([
      { name: 'blender', command: 'uvx', args: ['blender-mcp'], env: { BLENDER_HOST: '127.0.0.1' } }
    ])
  })

  it('非法 JSON / 畸形条目 → 跳过并返回空（不阻断会话创建）', async () => {
    const bad = path.join(dir, 'bad.json')
    await writeFile(bad, '{not json')
    process.env.EXTRA_MCP_FILE = bad
    expect(await readExtraMcpServers()).toEqual([])

    const malformed = path.join(dir, 'malformed.json')
    await writeFile(
      malformed,
      JSON.stringify([
        { command: 'no-name' },
        { name: 'bad name with space', command: 'x' },
        { name: 'ok', command: 'cmd' }
      ])
    )
    process.env.EXTRA_MCP_FILE = malformed
    const out = await readExtraMcpServers()
    expect(out).toEqual([{ name: 'ok', command: 'cmd' }])
  })

  it('extraMcpTomlLines：展开为 codex stdio MCP 段，含转义', () => {
    const lines = extraMcpTomlLines([
      {
        name: 'blender',
        command: 'uvx',
        args: ['blender-mcp', '--host', 'a"b'],
        env: { K: 'v\\1' }
      }
    ])
    expect(lines).toEqual([
      '[mcp_servers.blender]',
      'command = "uvx"',
      'args = ["blender-mcp", "--host", "a\\"b"]',
      'env = { "K" = "v\\\\1" }',
      ''
    ])
  })
})
