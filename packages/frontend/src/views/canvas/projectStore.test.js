import { describe, it, expect } from 'vitest'
import {
  makeProject,
  emptyStore,
  migrateLegacyStore,
  normalizeStore,
  addProject,
  renameProject,
  deleteProject,
  switchProject,
  updateProjectDoc,
  cloneProject,
  importProject,
} from './projectStore'

const legacyDoc = JSON.stringify({
  version: 2,
  name: '旧画布',
  viewport: { scale: 0.5, x: 10, y: 20 },
  objects: [
    { id: 'o1', type: 'note', x: 0, y: 0, width: 10, height: 10, text: 'a' },
    { id: 'o2', type: 'image', x: 50, y: 50, width: 20, height: 20, src: 'http://x/1.png' },
  ],
  links: [{ id: 'l1', from: 'o1', to: 'o2' }],
  groups: [{ id: 'g1', members: ['o1', 'o2'] }],
})

describe('migrateLegacyStore', () => {
  it('旧档升格为首个项目（内容完整保留）', () => {
    const { store, migrated } = migrateLegacyStore(null, legacyDoc)
    expect(migrated).toBe(true)
    expect(store.projects).toHaveLength(1)
    const p = store.projects[0]
    expect(store.activeId).toBe(p.id)
    expect(p.title).toBe('旧画布')
    expect(p.doc.objects).toHaveLength(2)
    expect(p.doc.links).toHaveLength(1)
    expect(p.doc.viewport.scale).toBe(0.5)
  })
  it('双空 → 新空项目', () => {
    const { store, migrated } = migrateLegacyStore(null, null)
    expect(migrated).toBe(true)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].doc.objects).toEqual([])
  })
  it('已有项目集 → 原样（不重复迁移）', () => {
    const existing = JSON.stringify({
      version: 1,
      activeId: 'a',
      projects: [{ id: 'a', title: 'A', createdAt: 1, updatedAt: 1, doc: { objects: [] } }],
    })
    const { store, migrated } = migrateLegacyStore(existing, legacyDoc)
    expect(migrated).toBe(false)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].title).toBe('A')
  })
  it('旧档空 objects → 不迁移为项目（走新建空项目）', () => {
    const emptyLegacy = JSON.stringify({ version: 1, objects: [], links: [] })
    const { store, migrated } = migrateLegacyStore(null, emptyLegacy)
    expect(migrated).toBe(true)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].doc.objects).toEqual([])
  })
  it('坏 JSON 容忍', () => {
    const { store } = migrateLegacyStore('{bad', '{also bad')
    expect(store.projects).toHaveLength(1)
  })
})

describe('projectStore CRUD', () => {
  const base = () => addProject(emptyStoreWithOne(), 'B')
  function emptyStoreWithOne() {
    return { version: 1, activeId: 'p1', projects: [makeProject('A', 'p1')] }
  }

  it('addProject 置顶并激活', () => {
    const s = base()
    expect(s.projects[0].title).toBe('B')
    expect(s.activeId).toBe(s.projects[0].id)
    expect(s.projects).toHaveLength(2)
  })
  it('renameProject 同步 doc.name，空标题忽略', () => {
    const s = renameProject(base(), 'p1', '新名字')
    expect(s.projects.find((p) => p.id === 'p1').title).toBe('新名字')
    expect(s.projects.find((p) => p.id === 'p1').doc.name).toBe('新名字')
    const s2 = renameProject(s, 'p1', '   ')
    expect(s2.projects.find((p) => p.id === 'p1').title).toBe('新名字')
  })
  it('deleteProject 删唯一项目自动补空', () => {
    const s = deleteProject(emptyStoreWithOne(), 'p1')
    expect(s.projects).toHaveLength(1)
    expect(s.projects[0].doc.objects).toEqual([])
    expect(s.activeId).toBe(s.projects[0].id)
  })
  it('deleteProject 删非激活项 activeId 不动', () => {
    const s = deleteProject(base(), 'p1')
    expect(s.projects).toHaveLength(1)
    expect(s.activeId).toBe(s.projects.find((p) => p.title === 'B').id)
  })
  it('switchProject 未知 id 原样', () => {
    const s = base()
    expect(switchProject(s, 'nope')).toBe(s)
    expect(switchProject(s, 'p1').activeId).toBe('p1')
  })
  it('updateProjectDoc 戳 updatedAt', () => {
    const doc = {
      version: 2,
      name: 'x',
      viewport: { scale: 1, x: 0, y: 0 },
      objects: [],
      links: [],
      groups: [],
    }
    const s = updateProjectDoc(base(), 'p1', doc, 12345)
    const p = s.projects.find((x) => x.id === 'p1')
    expect(p.doc).toBe(doc)
    expect(p.updatedAt).toBe(12345)
  })
  it('cloneProject 深拷贝（改克隆不影响原）', () => {
    const s = base()
    const c = cloneProject(s, 'p1')
    expect(c.id).toBe('p1')
    c.doc.objects.push({ id: 'zz' })
    expect(s.projects.find((p) => p.id === 'p1').doc.objects).toHaveLength(0)
  })
  it('importProject id 碰撞换新 id 并激活', () => {
    const s = base()
    const incoming = makeProject('外来', 'p1')
    const { store, id } = importProject(s, incoming)
    expect(id).not.toBe('p1')
    expect(store.projects).toHaveLength(3)
    expect(store.activeId).toBe(id)
    expect(store.projects[0].title).toBe('外来')
  })
  it('importProject 残缺数据拒绝', () => {
    const s = base()
    expect(importProject(s, null).id).toBeNull()
    expect(importProject(s, { title: 'x' }).id).toBeNull()
    expect(s.projects).toHaveLength(2)
  })
})

describe('normalizeStore', () => {
  it('过滤残缺项目并修正 activeId', () => {
    const s = normalizeStore({
      version: 1,
      activeId: 'gone',
      projects: [
        null,
        { id: 'ok', doc: { objects: [], viewport: { scale: 2 } } },
        { id: 'bad', noDoc: true },
      ],
    })
    expect(s.projects).toHaveLength(1)
    expect(s.projects[0].id).toBe('ok')
    expect(s.activeId).toBe('ok')
    expect(s.projects[0].doc.viewport.scale).toBe(2)
  })
})
