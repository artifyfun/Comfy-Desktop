// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

/**
 * deployWorkbenchSkills 单测：skill 源目录 → $CODEX_HOME/skills/ 的复制语义。
 * electron app 对象被 mock（getAppPath 指向临时 fixture），fs 直接走真实实现
 * （tmpdir 内操作，确定性、无网络、无 sleep）——符合 AGENTS.md 零 flaky 要求。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => tmpdir() }
}))

// service 的 import 链会拉起 appStore/templates/agentDriver 等重依赖；
// 与路由测试同一套 mock（只 mock 模块面，不触真实实现）。
vi.mock('../appStore', () => ({
  default: {
    on: vi.fn(),
    getConfig: vi.fn(() => ({})),
    getAllApps: vi.fn(() => [])
  }
}))
vi.mock('../../settings', () => ({ get: vi.fn(() => undefined) }))
vi.mock('../agentDriver', () => ({ buildAppCode: vi.fn() }))
vi.mock('./templates', () => ({
  templateLibrary: { list: vi.fn(() => []), on: vi.fn() }
}))
vi.mock('../mcp/executor', () => ({}))
vi.mock('../server', () => ({
  getServerPort: vi.fn(() => 0),
  startServer: vi.fn()
}))

// process.resourcesPath 在 node 测试环境未定义 → 走开发态分支
;(globalThis as Record<string, unknown>).process ||= process

import { deployWorkbenchSkillsForTest } from './service'

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'wb-skills-test-'))
  const skillsSrc = join(root, 'public', 'workbench-skills')
  mkdirSync(join(skillsSrc, 'wb-orchestration'), { recursive: true })
  mkdirSync(join(skillsSrc, '_not-a-skill'), { recursive: true })
  writeFileSync(join(skillsSrc, 'wb-orchestration', 'SKILL.md'), '# orchestration')
  // 无 SKILL.md 的目录应被跳过
  writeFileSync(join(skillsSrc, '_not-a-skill', 'README.md'), 'no skill here')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('deployWorkbenchSkills', () => {
  it('复制每个含 SKILL.md 的子目录到 CODEX_HOME/skills/，跳过无 SKILL.md 的目录', () => {
    const fx = makeFixture()
    try {
      const codexHome = join(fx.root, 'codex-home')
      mkdirSync(codexHome, { recursive: true })
      deployWorkbenchSkillsForTest(codexHome, join(fx.root, 'public', 'workbench-skills'))
      expect(readFileSync(join(codexHome, 'skills', 'wb-orchestration', 'SKILL.md'), 'utf8')).toBe(
        '# orchestration'
      )
      expect(existsSync(join(codexHome, 'skills', '_not-a-skill'))).toBe(false)
    } finally {
      fx.cleanup()
    }
  })

  it('源目录不存在时静默返回（打包路径漂移不阻断会话创建）', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'wb-skills-empty-'))
    try {
      deployWorkbenchSkillsForTest(codexHome, join(codexHome, 'does-not-exist'))
      // 不创建任何东西，也不抛
      expect(existsSync(join(codexHome, 'skills'))).toBe(false)
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})
