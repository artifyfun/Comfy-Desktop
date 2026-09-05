// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

/**
 * SkillLibrary 单测：部署（整目录复制+启停过滤）/ CRUD（含改名联动）/
 * 规范校验 / 本机扫描 / 三路径导入（dir/text/zip，含冲突三策略）。
 * electron 被 mock（模块顶层 import app，测试直接构造 SkillLibrary 实例），
 * fs 走真实实现（tmpdir 内操作）——零 flaky、无网络。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

vi.mock('electron', () => ({ app: { getAppPath: () => '', getPath: () => tmpdir() } }))

import { SkillLibrary } from './skillStore'

const SKILL = (name: string, description = 'Does X when Y.') =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nBody of ${name}.`

function makeLib(builtin?: string) {
  const root = mkdtempSync(join(tmpdir(), 'wb-skilllib-'))
  const userRoot = join(root, 'user-skills')
  const statePath = join(root, 'states.json')
  mkdirSync(userRoot, { recursive: true })
  const lib = new SkillLibrary({ builtinRoot: builtin, userRoot, statePath })
  return {
    lib,
    root,
    userRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function builtinFixture(root: string): string {
  const builtinRoot = join(root, 'builtin')
  mkdirSync(join(builtinRoot, 'wb-orchestration', 'scripts'), { recursive: true })
  mkdirSync(join(builtinRoot, '_not-a-skill'), { recursive: true })
  writeFileSync(join(builtinRoot, 'wb-orchestration', 'SKILL.md'), SKILL('wb-orchestration'))
  writeFileSync(join(builtinRoot, 'wb-orchestration', 'scripts', 'run.js'), '// helper')
  writeFileSync(join(builtinRoot, '_not-a-skill', 'README.md'), 'no skill here')
  return builtinRoot
}

describe('SkillLibrary.deployTo', () => {
  it('内置整目录复制（含 scripts/ 子目录），跳过无 SKILL.md 的目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-skilllib-'))
    const userRoot = join(root, 'user-skills')
    mkdirSync(userRoot, { recursive: true })
    const lib = new SkillLibrary({
      builtinRoot: builtinFixture(root),
      userRoot,
      statePath: join(root, 'states.json')
    })
    const cleanup = () => rmSync(root, { recursive: true, force: true })
    try {
      const codexHome = join(root, 'codex-home')
      mkdirSync(codexHome, { recursive: true })
      lib.deployTo(codexHome)
      expect(
        readFileSync(join(codexHome, 'skills', 'wb-orchestration', 'SKILL.md'), 'utf8')
      ).toContain('name: wb-orchestration')
      // 整目录复制：附加资源一并部署
      expect(existsSync(join(codexHome, 'skills', 'wb-orchestration', 'scripts', 'run.js'))).toBe(
        true
      )
      expect(existsSync(join(codexHome, 'skills', '_not-a-skill'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('用户技能：enabled 才部署；停用与校验不通过的跳过', () => {
    const { lib, root, userRoot, cleanup } = makeLib()
    try {
      mkdirSync(join(userRoot, 'good'), { recursive: true })
      writeFileSync(join(userRoot, 'good', 'SKILL.md'), SKILL('good'))
      mkdirSync(join(userRoot, 'off'), { recursive: true })
      writeFileSync(join(userRoot, 'off', 'SKILL.md'), SKILL('off'))
      mkdirSync(join(userRoot, 'badname'), { recursive: true })
      // name 与目录名不一致 → 校验不通过
      writeFileSync(join(userRoot, 'badname', 'SKILL.md'), SKILL('other-name'))
      lib.setEnabled('off', false)

      const codexHome = join(root, 'codex-home')
      mkdirSync(codexHome, { recursive: true })
      lib.deployTo(codexHome)
      expect(existsSync(join(codexHome, 'skills', 'good', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(codexHome, 'skills', 'off'))).toBe(false)
      expect(existsSync(join(codexHome, 'skills', 'badname'))).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe('SkillLibrary CRUD', () => {
  it('create → list → remove；create 校验非法名', () => {
    const { lib, cleanup } = makeLib()
    try {
      expect(lib.create({ name: 'my-skill', description: 'd', body: 'b' }).ok).toBe(true)
      // wb- 前缀保留给内置
      expect(lib.create({ name: 'wb-x', description: 'd', body: 'b' }).ok).toBe(false)
      // 非法字符
      expect(lib.create({ name: 'My_Skill', description: 'd', body: 'b' }).ok).toBe(false)
      // 重名
      expect(lib.create({ name: 'my-skill', description: 'd', body: 'b' }).ok).toBe(false)

      const list = lib.list()
      expect(list.map((s) => s.name)).toEqual(['my-skill'])
      expect(list[0]!.enabled).toBe(true)
      expect(list[0]!.tokens).toBeGreaterThan(0)

      expect(lib.remove('my-skill')).toBe(true)
      expect(lib.list()).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('update 正文/描述；改名迁移目录与状态并返回 renamedTo', () => {
    const { lib, userRoot, cleanup } = makeLib()
    try {
      lib.create({ name: 'old-name', description: 'old desc', body: 'v1' })
      // 改正文
      expect(lib.update('old-name', { body: 'v2 body' }).ok).toBe(true)
      expect(lib.read('old-name')!.body).toContain('v2 body')
      // 改描述（含 YAML 特殊字符）
      expect(lib.update('old-name', { description: 'uses: colon, "quotes"' }).ok).toBe(true)
      expect(lib.read('old-name')!.description).toBe('uses: colon, "quotes"')
      // 改名：目录+状态迁移
      lib.setEnabled('old-name', false)
      const r = lib.update('old-name', { name: 'new-name' })
      expect(r.ok).toBe(true)
      expect(r.renamedTo).toBe('new-name')
      expect(existsSync(join(userRoot, 'old-name'))).toBe(false)
      expect(existsSync(join(userRoot, 'new-name'))).toBe(true)
      // 状态（enabled=false）随改名保留
      expect(lib.list().find((s) => s.name === 'new-name')!.enabled).toBe(false)
      // builtin 只读
      const broot = mkdtempSync(join(tmpdir(), 'wb-skilllib2-'))
      const lib2 = new SkillLibrary({
        builtinRoot: builtinFixture(broot),
        userRoot: join(broot, 'u'),
        statePath: join(broot, 's.json')
      })
      try {
        expect(lib2.update('wb-orchestration', { body: 'x' }).ok).toBe(false)
        expect(lib2.remove('wb-orchestration')).toBe(false)
      } finally {
        rmSync(broot, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })
})

describe('SkillLibrary.scanLocalAgents', () => {
  it('扫描 ~/.claude/skills 等目录，标记 alreadyImported', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-fakehome-'))
    const os = await import('node:os')
    const spy = vi.spyOn(os.default, 'homedir').mockReturnValue(home)
    const { lib, userRoot, cleanup } = makeLib()
    try {
      mkdirSync(join(home, '.claude', 'skills', 'pdf-pro'), { recursive: true })
      writeFileSync(join(home, '.claude', 'skills', 'pdf-pro', 'SKILL.md'), SKILL('pdf-pro'))
      // 已导入同名 → alreadyImported
      mkdirSync(join(userRoot, 'mine'), { recursive: true })
      writeFileSync(join(userRoot, 'mine', 'SKILL.md'), SKILL('mine'))
      mkdirSync(join(home, '.claude', 'skills', 'mine'), { recursive: true })
      writeFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), SKILL('mine'))

      const sources = lib.scanLocalAgents()
      expect(sources).toHaveLength(1)
      expect(sources[0]!.label).toBe('Claude Code')
      const byName = Object.fromEntries(sources[0]!.skills.map((s) => [s.name, s]))
      expect(byName['pdf-pro']!.alreadyImported).toBe(false)
      expect(byName['mine']!.alreadyImported).toBe(true)
    } finally {
      spy.mockRestore()
      cleanup()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('SkillLibrary 导入', () => {
  it('importFromDir：单技能目录与父目录批量模式', () => {
    const { lib, root, cleanup } = makeLib()
    try {
      const src = join(root, 'src')
      mkdirSync(join(src, 'skill-a'), { recursive: true })
      mkdirSync(join(src, 'skill-b'), { recursive: true })
      writeFileSync(join(src, 'skill-a', 'SKILL.md'), SKILL('skill-a'))
      writeFileSync(join(src, 'skill-b', 'SKILL.md'), SKILL('skill-b'))

      // 父目录模式
      const r1 = lib.importFromDir(src, 'claude', 'skip')
      expect(r1.imported.sort()).toEqual(['skill-a', 'skill-b'])
      // 再导一次 → skip
      const r2 = lib.importFromDir(src, 'claude', 'skip')
      expect(r2.skipped).toHaveLength(2)
      // overwrite 不新增
      const r3 = lib.importFromDir(src, 'claude', 'overwrite')
      expect(r3.imported).toHaveLength(2)
      expect(lib.list().filter((s) => !s.builtin)).toHaveLength(2)
      // rename 加后缀
      const r4 = lib.importFromDir(join(src, 'skill-a'), 'claude', 'rename')
      expect(r4.imported).toEqual(['skill-a-2'])
    } finally {
      cleanup()
    }
  })

  it('importFromText：解析 frontmatter；wb- 前缀拒绝', () => {
    const { lib, cleanup } = makeLib()
    try {
      const r1 = lib.importFromText(SKILL('pasted-skill', 'From chat.'), 'manual', 'skip')
      expect(r1.imported).toEqual(['pasted-skill'])
      expect(lib.read('pasted-skill')!.description).toBe('From chat.')
      const r2 = lib.importFromText(SKILL('wb-hack'), 'manual', 'skip')
      expect(r2.failed).toHaveLength(1)
      const r3 = lib.importFromText('no frontmatter here', 'manual', 'skip')
      expect(r3.failed).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('importFromZip：标准结构与仓库壳都认，附加资源文件随包写入', () => {
    const { lib, userRoot, cleanup } = makeLib()
    try {
      // 标准结构 <name>/SKILL.md
      const z1 = zipSync({
        'zip-skill/SKILL.md': strToU8(SKILL('zip-skill')),
        'zip-skill/references/deep.md': strToU8('# deep')
      })
      const r1 = lib.importFromZip(Buffer.from(z1), 'github', 'skip')
      expect(r1.imported).toEqual(['zip-skill'])
      expect(existsSync(join(userRoot, 'zip-skill', 'references', 'deep.md'))).toBe(true)

      // 仓库壳 repo-main/<name>/SKILL.md（zipball）
      const z2 = zipSync({
        'repo-main/shell-skill/SKILL.md': strToU8(SKILL('shell-skill')),
        'repo-main/README.md': strToU8('readme')
      })
      const r2 = lib.importFromZip(Buffer.from(z2), 'github', 'skip')
      expect(r2.imported).toEqual(['shell-skill'])
    } finally {
      cleanup()
    }
  })
})
