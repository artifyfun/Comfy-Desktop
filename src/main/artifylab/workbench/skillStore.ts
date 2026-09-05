/**
 * 工作台技能库（Agent Skills 开放标准，agentskills.io）。
 *
 * 概念（与模板严格分家）：
 * - 模板 template = 用户固化的 app，可执行（wb_execute_template）
 * - 技能 skill   = SKILL.md 知识文档（frontmatter + 正文），codex 原生
 *   扫描 $CODEX_HOME/skills/ 渐进式加载（name+description 常驻 ~60t，
 *   正文按需读取）
 *
 * 存储布局：
 * - 内置：随包发布 public/workbench-skills（extraResources → resources/workbench-skills），只读
 * - 用户：userData/artify-skills/<name>/SKILL.md（+可选 scripts/references/assets）
 * - 状态：userData/workbench-skills.json（enabled/source/order/importedAt）——
 *   刻意不写进技能目录：目录保持纯开放标准，可整目录拷走 / 提交 git / 给
 *   Claude Code 等其它 agent 直接用
 *
 * 解析/校验/token 估算全部委托 agent-skills-ts-sdk（规范官方 TS 实现），不自研。
 * 纯 fs 层可单测（electron 路径只在 defaultSkillLibrary() 里）。
 */
import { join, resolve, sep, dirname, basename } from 'node:path'
import os from 'node:os'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { unzipSync } from 'fflate'
import { app } from 'electron'
import { parseSkillContent, validateSkillContent, estimateTokens } from 'agent-skills-ts-sdk'
import { logger } from '../utils/logger'

/** 用户技能名规则：同规范 name 规则，且禁止占用内置 wb- 前缀 */
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const BUILTIN_PREFIX = 'wb-'
const MAX_BODY_BYTES = 256 * 1024
/** zip 解包防护：单文件 / 总量上限（zip bomb guard） */
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024

export type SkillSource = 'builtin' | 'local' | 'claude' | 'codex' | 'github' | 'manual'

export interface SkillState {
  enabled: boolean
  source: SkillSource
  order: number
  importedAt?: number
}

export interface SkillInfo {
  /** = 技能目录名 = frontmatter.name（规范强制一致），主键 */
  name: string
  description: string
  builtin: boolean
  enabled: boolean
  source: SkillSource
  order: number
  /** 正文 tokens（estimateTokens 官方实现） */
  tokens: number
  /** 常驻开销估算（name+description，codex 只注入这段） */
  residentTokens: number
  /** 规范校验是否通过（不通过的技能不部署） */
  valid: boolean
  issues: string[]
  license?: string
  importedAt?: number
  /** 附加资源目录（scripts/references/assets 是否存在，UI 展示用） */
  extras: string[]
  /** 分类 id（内置技能来自 catalog.json；用户技能无分类） */
  category?: string
}

export interface SkillContent {
  name: string
  description: string
  body: string
  raw: string
  builtin: boolean
  license?: string
}

export interface DiscoveredSkill {
  name: string
  description: string
  tokens: number
  /** 技能目录绝对路径（导入源） */
  dir: string
  alreadyImported: boolean
}

export interface DiscoveredSource {
  label: string
  path: string
  /** 导入时应标记的来源（claude/codex/local…） */
  source: SkillSource
  skills: DiscoveredSkill[]
}

export type ImportMode = 'skip' | 'overwrite' | 'rename'

export interface ImportResult {
  imported: string[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
}

export interface SkillLibraryOptions {
  builtinRoot?: string
  userRoot: string
  statePath: string
}

const SOURCE_LABELS: Array<{ label: string; sub: string; source: SkillSource }> = [
  { label: 'Claude Code', sub: '.claude/skills', source: 'claude' },
  { label: 'Codex CLI', sub: '.codex/skills', source: 'codex' },
  { label: 'Cursor', sub: '.cursor/skills', source: 'local' },
  { label: 'Gemini CLI', sub: '.gemini/skills', source: 'local' }
]

export class SkillLibrary {
  private opts: SkillLibraryOptions
  private stateCache: Record<string, SkillState> | null = null
  /** 内置技能分类清单（builtinRoot/catalog.json），name → category id */
  private catalogCache: Record<string, string> | null = null

  constructor(opts: SkillLibraryOptions) {
    this.opts = opts
  }

  /** 分类清单：只认内置根目录下的 catalog.json；缺失/损坏时返回空映射 */
  private catalog(): Record<string, string> {
    if (this.catalogCache) return this.catalogCache
    const file = join(this.opts.builtinRoot ?? '', 'catalog.json')
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      this.catalogCache = parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {}
    } catch {
      this.catalogCache = {}
    }
    return this.catalogCache!
  }

  // ---------------- 状态（userData/workbench-skills.json） ----------------

  private states(): Record<string, SkillState> {
    if (!this.stateCache) {
      try {
        const raw = readFileSync(this.opts.statePath, 'utf8')
        this.stateCache = JSON.parse(raw)?.states ?? {}
      } catch {
        this.stateCache = {}
      }
    }
    return this.stateCache!
  }

  private saveStates(): void {
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true })
      writeFileSync(this.opts.statePath, JSON.stringify({ states: this.states() }, null, 2))
    } catch (e) {
      logger.warn('workbench skill states save failed', e)
    }
  }

  private stateOf(name: string, builtin: boolean): SkillState {
    const s = this.states()[name]
    if (s) return s
    return builtin
      ? { enabled: true, source: 'builtin', order: 0 }
      : { enabled: true, source: 'manual', order: 100 }
  }

  setEnabled(name: string, enabled: boolean): SkillState {
    const info = this.find(name)
    if (!info) throw new Error(`skill not found: ${name}`)
    const st = { ...this.stateOf(name, info.builtin), enabled }
    this.states()[name] = st
    this.saveStates()
    return st
  }

  // ---------------- 目录与解析 ----------------

  private userRoot(): string {
    return this.opts.userRoot
  }

  private dirOf(name: string, builtin: boolean): string {
    return builtin ? join(this.opts.builtinRoot ?? '', name) : join(this.userRoot(), name)
  }

  /** 解析单个 SKILL.md（不抛错，invalid 时返回 issues） */
  private inspect(dir: string, name: string, builtin: boolean): SkillInfo | null {
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) return null
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    let description = ''
    let license: string | undefined
    let valid = true
    const issues: string[] = []
    try {
      const { properties } = parseSkillContent(raw)
      description = String(properties.description ?? '')
      license = properties.license ? String(properties.license) : undefined
      const errs = validateSkillContent(raw)
      if (errs.length) {
        valid = false
        issues.push(
          ...errs.map((e) =>
            typeof e === 'string' ? e : String((e as { message?: string }).message ?? e)
          )
        )
      }
      if (!builtin && properties.name !== name) {
        valid = false
        issues.push(`name (${String(properties.name)}) 与目录名 (${name}) 不一致`)
      }
    } catch (e) {
      valid = false
      issues.push(`SKILL.md 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    const st = this.stateOf(name, builtin)
    const extras = ['scripts', 'references', 'assets'].filter((d) => existsSync(join(dir, d)))
    return {
      name,
      description,
      builtin,
      enabled: st.enabled,
      source: st.source,
      order: st.order,
      tokens: estimateTokens(raw),
      residentTokens: estimateTokens(`${name}: ${description}`),
      valid,
      issues,
      license,
      importedAt: st.importedAt,
      extras,
      category: builtin ? this.catalog()[name] : undefined
    }
  }

  private builtinNames(): string[] {
    const root = this.opts.builtinRoot
    if (!root || !existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
      .map((e) => e.name)
  }

  private userNames(): string[] {
    const root = this.userRoot()
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
      .map((e) => e.name)
  }

  find(name: string): SkillInfo | null {
    if (this.builtinNames().includes(name)) return this.inspect(this.dirOf(name, true), name, true)
    if (this.userNames().includes(name)) return this.inspect(this.dirOf(name, false), name, false)
    return null
  }

  /** 全量清单：内置在前（order 0），用户按 order/name 升序 */
  list(): SkillInfo[] {
    const builtins = this.builtinNames()
      .map((n) => this.inspect(this.dirOf(n, true), n, true))
      .filter((i): i is SkillInfo => !!i)
    const users = this.userNames()
      .map((n) => this.inspect(this.dirOf(n, false), n, false))
      .filter((i): i is SkillInfo => !!i)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    return [...builtins, ...users]
  }

  read(name: string): SkillContent | null {
    const builtin = this.builtinNames().includes(name)
    if (!builtin && !this.userNames().includes(name)) return null
    const raw = readFileSync(join(this.dirOf(name, builtin), 'SKILL.md'), 'utf8')
    const { properties, body } = parseSkillContent(raw)
    return {
      name: String(properties.name ?? name),
      description: String(properties.description ?? ''),
      body,
      raw,
      builtin,
      license: properties.license ? String(properties.license) : undefined
    }
  }

  // ---------------- 名称与路径安全 ----------------

  private assertValidName(name: string): string | null {
    if (!NAME_RE.test(name)) return '名称仅限小写字母/数字/连字符，字母或数字开头结尾'
    if (name.length > 64) return '名称最长 64 字符'
    if (this.builtinNames().includes(name)) return '与内置技能同名'
    if (name.startsWith(BUILTIN_PREFIX))
      return `用户技能不能使用 ${BUILTIN_PREFIX} 前缀（内置保留）`
    return null
  }

  /** 防路径穿越：目标必须仍在基座目录内 */
  private safeJoin(base: string, ...parts: string[]): string | null {
    const target = resolve(base, ...parts)
    const baseAbs = resolve(base)
    if (target !== baseAbs && !target.startsWith(baseAbs + sep)) return null
    return target
  }

  // ---------------- CRUD ----------------

  create(input: { name: string; description: string; body: string }): {
    ok: boolean
    error?: string
  } {
    const name = input.name.trim()
    const err = this.assertValidName(name)
    if (err) return { ok: false, error: err }
    const content = buildSkillMd(name, input.description.trim(), input.body)
    const problems = validateSkillContent(content)
    if (problems.length) {
      return {
        ok: false,
        error: problems
          .map((p) =>
            typeof p === 'string' ? p : String((p as { message?: string }).message ?? p)
          )
          .join('; ')
      }
    }
    if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, error: '正文超过 256KB，请把重型内容拆到 references/' }
    }
    const dir = this.dirOf(name, false)
    if (existsSync(dir)) return { ok: false, error: `技能 ${name} 已存在` }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content)
    this.states()[name] = { enabled: true, source: 'manual', order: 100 }
    this.saveStates()
    return { ok: true }
  }

  /**
   * 更新（正文/描述/改名）。改名返回 renamedTo 供上层修正预设引用。
   * 目录内脚本等附加资源随 cpSync 一并迁移。
   */
  update(
    name: string,
    patch: { name?: string; description?: string; body?: string }
  ): { ok: boolean; error?: string; renamedTo?: string } {
    const cur = this.find(name)
    if (!cur) return { ok: false, error: `skill not found: ${name}` }
    if (cur.builtin) return { ok: false, error: 'builtin skill is readonly' }
    const nextName = (patch.name ?? name).trim()
    if (nextName !== name) {
      const err = this.assertValidName(nextName)
      if (err) return { ok: false, error: err }
      if (existsSync(this.dirOf(nextName, false))) {
        return { ok: false, error: `技能 ${nextName} 已存在` }
      }
    }
    const srcDir = this.dirOf(name, false)
    const old = readFileSync(join(srcDir, 'SKILL.md'), 'utf8')
    const { body } = parseSkillContent(old)
    const nextBody = patch.body !== undefined ? patch.body : body
    const nextDesc = patch.description !== undefined ? patch.description.trim() : cur.description
    const content = buildSkillMd(nextName, nextDesc, nextBody)
    const problems = validateSkillContent(content)
    if (problems.length) {
      return {
        ok: false,
        error: problems
          .map((p) =>
            typeof p === 'string' ? p : String((p as { message?: string }).message ?? p)
          )
          .join('; ')
      }
    }
    if (Buffer.byteLength(nextBody, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, error: '正文超过 256KB，请把重型内容拆到 references/' }
    }
    if (nextName !== name) {
      const destDir = this.dirOf(nextName, false)
      mkdirSync(dirname(destDir), { recursive: true })
      cpSync(srcDir, destDir, { recursive: true })
      rmSync(srcDir, { recursive: true, force: true })
      const st = this.states()[name]
      if (st) {
        delete this.states()[name]
        this.states()[nextName] = st
      }
      this.saveStates()
      writeFileSync(join(destDir, 'SKILL.md'), content)
      return { ok: true, renamedTo: nextName }
    }
    writeFileSync(join(srcDir, 'SKILL.md'), content)
    return { ok: true }
  }

  remove(name: string): boolean {
    if (this.builtinNames().includes(name)) return false
    const dir = this.dirOf(name, false)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    delete this.states()[name]
    this.saveStates()
    return true
  }

  // ---------------- 部署（CODEX_HOME/skills/） ----------------

  /**
   * 整目录复制部署：内置全量 + 用户 enabled。
   * 与旧版差异：① 不再只拷 SKILL.md（标准技能可带 scripts/references/assets）
   * ② 用户技能参与部署 ③ 校验不通过的技能跳过。
   */
  deployTo(codexHome: string): void {
    const destRoot = join(codexHome, 'skills')
    mkdirSync(destRoot, { recursive: true })
    let count = 0
    for (const info of this.list()) {
      if (!info.valid || !info.enabled) continue
      const srcDir = this.dirOf(info.name, info.builtin)
      const dest = this.safeJoin(destRoot, info.name)
      if (!dest) continue
      try {
        cpSync(srcDir, dest, { recursive: true })
        count++
      } catch (e) {
        logger.warn(`deploy skill ${info.name} failed`, e)
      }
    }
    if (count > 0) logger.debug(`deployed ${count} skills to ${destRoot}`)
  }

  // ---------------- 本机 agent 目录扫描 ----------------

  /** 扫描 ~/.claude/skills 等本机其它 agent 的技能目录 */
  scanLocalAgents(): DiscoveredSource[] {
    const home = os.homedir()
    const existing = new Set([...this.builtinNames(), ...this.userNames()])
    const out: DiscoveredSource[] = []
    for (const { label, sub, source } of SOURCE_LABELS) {
      const root = join(home, sub)
      if (!existsSync(root)) continue
      const skills: DiscoveredSkill[] = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(root, entry.name)
        const info = this.inspect(dir, entry.name, false)
        if (!info) continue
        skills.push({
          name: entry.name,
          description: info.description,
          tokens: info.tokens,
          dir,
          alreadyImported: existing.has(entry.name)
        })
      }
      if (skills.length) out.push({ label, path: root, source, skills })
    }
    return out
  }

  // ---------------- 导入 ----------------

  /**
   * 从本机目录导入。srcDir 可以是单个技能目录（含 SKILL.md），
   * 也可以是技能父目录（其下每个含 SKILL.md 的子目录各算一个技能）。
   */
  importFromDir(srcDir: string, source: SkillSource, mode: ImportMode): ImportResult {
    const abs = resolve(srcDir)
    if (!existsSync(join(abs, 'SKILL.md'))) {
      // 父目录模式：逐子目录导入，结果聚合
      const result: ImportResult = { imported: [], skipped: [], failed: [] }
      if (!existsSync(abs)) {
        result.failed.push({ name: basename(srcDir), error: 'directory not found' })
        return result
      }
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(abs, entry.name, 'SKILL.md'))) continue
        const r = this.importSingleDir(join(abs, entry.name), source, mode)
        this.mergeImport(result, r)
      }
      return result
    }
    return this.importSingleDir(abs, source, mode)
  }

  private mergeImport(into: ImportResult, r: ImportResult): void {
    into.imported.push(...r.imported)
    into.skipped.push(...r.skipped)
    into.failed.push(...r.failed)
  }

  private importSingleDir(srcDir: string, source: SkillSource, mode: ImportMode): ImportResult {
    const result: ImportResult = { imported: [], skipped: [], failed: [] }
    const name = basename(srcDir)
    const file = join(srcDir, 'SKILL.md')
    if (!existsSync(file)) {
      result.failed.push({ name, error: 'SKILL.md not found' })
      return result
    }
    const raw = readFileSync(file, 'utf8')
    const parsed = this.validateRaw(raw, name)
    if (parsed.error) {
      result.failed.push({ name, error: parsed.error })
      return result
    }
    const target = this.resolveTarget(name, mode)
    if ('skip' in target) {
      result.skipped.push({ name, reason: target.skip })
      return result
    }
    try {
      cpSync(srcDir, target.dir, { recursive: true })
      this.markImported(target.name, source)
      result.imported.push(target.name)
    } catch (e) {
      result.failed.push({ name, error: e instanceof Error ? e.message : String(e) })
    }
    return result
  }

  /** 粘贴 SKILL.md 全文导入（name 取 frontmatter） */
  importFromText(text: string, source: SkillSource, mode: ImportMode): ImportResult {
    const result: ImportResult = { imported: [], skipped: [], failed: [] }
    let properties: Record<string, unknown>
    try {
      properties = parseSkillContent(text).properties as unknown as Record<string, unknown>
    } catch (e) {
      result.failed.push({
        name: '(pasted)',
        error: `解析失败: ${e instanceof Error ? e.message : String(e)}`
      })
      return result
    }
    const name = String(properties.name ?? '').trim()
    if (!name) {
      result.failed.push({ name: '(pasted)', error: 'frontmatter 缺少 name' })
      return result
    }
    const parsed = this.validateRaw(text, name)
    if (parsed.error) {
      result.failed.push({ name, error: parsed.error })
      return result
    }
    const target = this.resolveTarget(name, mode)
    if ('skip' in target) {
      result.skipped.push({ name, reason: target.skip })
      return result
    }
    try {
      mkdirSync(target.dir, { recursive: true })
      writeFileSync(join(target.dir, 'SKILL.md'), text)
      this.markImported(target.name, source)
      result.imported.push(target.name)
    } catch (e) {
      result.failed.push({ name, error: e instanceof Error ? e.message : String(e) })
    }
    return result
  }

  /**
   * zip 导入（GitHub zipball / 手工打包）。顶层结构两种都认：
   * `<name>/SKILL.md`（标准）或 `repo-main/<name>/SKILL.md`（zipball）。
   */
  importFromZip(buf: Buffer, source: SkillSource, mode: ImportMode): ImportResult {
    const result: ImportResult = { imported: [], skipped: [], failed: [] }
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(buf), {
        filter: (f) => f.size <= MAX_ZIP_ENTRY_BYTES
      })
    } catch (e) {
      result.failed.push({
        name: '(zip)',
        error: `解压失败: ${e instanceof Error ? e.message : String(e)}`
      })
      return result
    }
    // 按「去掉仓库顶层壳后的技能目录」分组。
    // 壳层数全局判定一次：存在 <x>/SKILL.md 即无壳；否则统一剥一层（zipball）。
    const allPaths = Object.keys(entries).map((p) => p.replace(/\\/g, '/'))
    const hasDirect = allPaths.some((p) => /^[^/]+\/SKILL\.md$/.test(p))
    const strip = hasDirect ? 0 : 1
    const groups = new Map<string, Map<string, Uint8Array>>()
    let total = 0
    for (const [path, data] of Object.entries(entries)) {
      total += data.byteLength
      if (total > MAX_ZIP_TOTAL_BYTES) {
        result.failed.push({ name: '(zip)', error: 'zip 解压总量超过 50MB 上限' })
        return result
      }
      const norm = path.replace(/\\/g, '/')
      if (norm.endsWith('/') || norm.includes('__MACOSX') || norm.split('/').pop()?.startsWith('.'))
        continue
      const parts = norm.split('/')
      if (parts.length <= strip) continue
      // 剥壳后按技能目录分组
      const skillParts = parts.slice(strip)
      const name = skillParts[0]!
      const rel = skillParts.join('/')
      if (!groups.has(name)) groups.set(name, new Map())
      groups.get(name)!.set(rel, data)
    }
    for (const [name, files] of groups) {
      const rawBuf = files.get(`${name}/SKILL.md`)
      if (!rawBuf) {
        // 不是技能目录（如仓库根的 README 层）→ 忽略
        continue
      }
      const raw = Buffer.from(rawBuf).toString('utf8')
      const parsed = this.validateRaw(raw, name)
      if (parsed.error) {
        result.failed.push({ name, error: parsed.error })
        continue
      }
      const target = this.resolveTarget(name, mode)
      if ('skip' in target) {
        result.skipped.push({ name, reason: target.skip })
        continue
      }
      try {
        for (const [rel, data] of files) {
          const dest = this.safeJoin(target.dir, rel.slice(name.length + 1))
          if (!dest) throw new Error(`非法路径: ${rel}`)
          mkdirSync(dirname(dest), { recursive: true })
          writeFileSync(dest, data)
        }
        this.markImported(target.name, source)
        result.imported.push(target.name)
      } catch (e) {
        result.failed.push({ name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (result.imported.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
      result.failed.push({ name: '(zip)', error: 'zip 内未找到任何 <name>/SKILL.md 结构' })
    }
    return result
  }

  // ---------------- 导入内部工具 ----------------

  private validateRaw(raw: string, name: string): { error?: string } {
    try {
      const problems = validateSkillContent(raw)
      if (problems.length) {
        return {
          error: problems
            .map((p) =>
              typeof p === 'string' ? p : String((p as { message?: string }).message ?? p)
            )
            .join('; ')
        }
      }
      const props = parseSkillContent(raw).properties as unknown as Record<string, unknown>
      if (String(props.name ?? '') !== name) {
        return { error: `name (${String(props.name)}) 与目录名 (${name}) 不一致` }
      }
      const err = this.assertValidName(name)
      if (err) return { error: err }
    } catch (e) {
      return { error: `解析失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    return {}
  }

  /** 冲突三策略 → 目标目录（skip 时返回 {skip: reason}） */
  private resolveTarget(
    name: string,
    mode: ImportMode
  ): { dir: string; name: string } | { skip: string } {
    if (this.builtinNames().includes(name)) return { skip: '与内置技能同名' }
    if (!this.userNames().includes(name)) {
      return { dir: this.dirOf(name, false), name }
    }
    if (mode === 'skip') return { skip: '同名已存在' }
    if (mode === 'overwrite') return { dir: this.dirOf(name, false), name }
    // rename：找空位 -2 -3 …
    let i = 2
    while (this.userNames().includes(`${name}-${i}`)) i++
    const alt = `${name}-${i}`
    return { dir: this.dirOf(alt, false), name: alt }
  }

  private markImported(name: string, source: SkillSource): void {
    const prev = this.states()[name]
    this.states()[name] = {
      enabled: prev?.enabled ?? true,
      source,
      order: prev?.order ?? 100,
      importedAt: Date.now()
    }
    this.saveStates()
  }
}

/** frontmatter + 正文 → SKILL.md 全文（description 双引号包裹，防冒号等 YAML 特殊字符破坏结构） */
function buildSkillMd(name: string, description: string, body: string): string {
  const desc = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `---
name: ${name}
description: "${desc}"
---

${body.replace(/^\s+/, '')}`
}

// ---------------- electron 默认实例 ----------------

let defaultLib: SkillLibrary | null = null

/** 生产/开发路径探测（与 service.deployWorkbenchSkills 同一套 candidates 规则） */
export function defaultSkillLibrary(): SkillLibrary {
  if (defaultLib) return defaultLib
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'workbench-skills') : '',
    join(app.getAppPath(), 'src/main/artifylab/public/workbench-skills')
  ].filter(Boolean)
  const builtinRoot = candidates.find((p) => existsSync(p))
  defaultLib = new SkillLibrary({
    builtinRoot,
    userRoot: join(app.getPath('userData'), 'artify-skills'),
    statePath: join(app.getPath('userData'), 'workbench-skills.json')
  })
  return defaultLib
}

/** 目录体积（导入预览用，best-effort） */
export function dirSize(dir: string): number {
  let total = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) total += dirSize(full)
      else total += statSync(full).size
    }
  } catch {
    /* ignore */
  }
  return total
}
