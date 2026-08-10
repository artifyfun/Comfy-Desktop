import Store from 'electron-store'
import { EventEmitter } from 'events'
import artifyUtils from '.'

/** A UI app 参数节点 —— 对应 ComfyUI 工作流里被挑出来的 widget（MCP 工具入参来源） */
export interface ParamNode {
  id: number
  category: 'input' | 'output'
  type: string
  name: string
  description?: string
  selectedWidget?: {
    name?: string
    type?: string
    options?: { values?: unknown[]; min?: number; max?: number; step?: number; precision?: number }
  }
  renderComponent?: string
  color?: string
  key?: string
}

/** ComfyUI API 格式 prompt: { [nodeId]: { class_type, inputs } } */
export type ComfyPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export interface AppTemplate {
  workflow?: unknown
  prompt?: ComfyPrompt
  paramsNodes?: ParamNode[]
}

export interface App {
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
  /** A UI 生成的完整模板（前端透传，服务端此前未声明类型） */
  template?: AppTemplate
}

export interface AppStore {
  apps: App[]
}

const getDefaultConfig = () => {
  const { comfy_origin, server_origin } = artifyUtils.getConfig()
  return {
    comfyHost: comfy_origin,
    serverHost: server_origin,
    lang: 'zh',
    theme: 'dark',
    activeAppId: '',
    max_tokens: 64000,
    temperature: 0,
    api_key: '',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
    buildStyleId: 'tech', // 新增构建风格ID
    ngrokAuthtoken: '' // 新增ngrok authtoken
  }
}

class AppStoreManager extends EventEmitter {
  private store: Store<AppStore>

  constructor() {
    super()
    this.store = new Store<AppStore>({
      name: 'artify-apps',
      defaults: {
        apps: []
      }
    })
  }

  // 获取所有apps
  getAllApps(): App[] {
    return this.store.get('apps', [])
  }

  // 根据ID获取app
  getAppById(id: string): App | undefined {
    const apps = this.getAllApps()
    return apps.find((app) => app.id === id)
  }

  // 创建app
  createApp(appData: Omit<App, 'id' | 'createdAt' | 'updatedAt'>): App {
    const apps = this.getAllApps()
    const newApp: App = {
      ...appData,
      id: this.generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    apps.unshift(newApp)
    this.store.set('apps', apps)
    this.emit('change')
    return newApp
  }

  // 更新app
  updateApp(id: string, appData: Partial<Omit<App, 'id' | 'createdAt'>>): App | null {
    const apps = this.getAllApps()
    const appIndex = apps.findIndex((app) => app.id === id)

    if (appIndex === -1) {
      return null
    }

    const existingApp = apps[appIndex]!
    const updatedApp: App = {
      ...existingApp,
      ...appData,
      updatedAt: Date.now()
    }

    apps[appIndex] = updatedApp
    this.store.set('apps', apps)
    this.emit('change')
    return updatedApp
  }

  // 删除app
  removeApp(id: string): boolean {
    const apps = this.getAllApps()
    const filteredApps = apps.filter((app) => app.id !== id)

    if (filteredApps.length === apps.length) {
      return false // 没有找到要删除的app
    }

    this.store.set('apps', filteredApps)
    this.emit('change')
    return true
  }

  // 导入apps（unshift到原apps，id相同则覆盖）
  importApps(apps: App[]): void {
    const oldApps = this.getAllApps()
    // 用Map去重，优先保留新导入的
    const appMap = new Map<string, App>()
    // 先插入新apps（顺序反转保证unshift效果）
    for (let i = apps.length - 1; i >= 0; i--) {
      const app = apps[i]!
      appMap.set(app.id, app)
    }
    // 再插入旧apps（如果id已存在则跳过）
    for (const app of oldApps) {
      if (!appMap.has(app.id)) {
        appMap.set(app.id, app)
      }
    }
    // 保证顺序：新apps在前，旧apps在后
    const mergedApps = Array.from(appMap.values())
    this.store.set('apps', mergedApps)
    this.emit('change')
  }

  // 获取config
  getConfig(): any {
    const defaultConfig = getDefaultConfig()
    const config = this.store.get('config', defaultConfig)
    config.comfyHost = defaultConfig.comfyHost
    config.serverHost = defaultConfig.serverHost
    return config
  }

  // 保存config
  saveConfig(config: any): void {
    const oldConfig = this.getConfig()
    this.store.set('config', {
      ...oldConfig,
      ...config
    })
  }

  // 生成唯一ID
  private generateId(): string {
    return (([1e7] as any) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (a: any) =>
      (a ^ ((Math.random() * 16) >> (a / 4))).toString(16)
    )
  }
}

// 创建单例实例
const appStoreManager = new AppStoreManager()

export default appStoreManager
