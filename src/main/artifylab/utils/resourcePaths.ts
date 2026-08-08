import { app } from 'electron'
import path from 'node:path'

/**
 * 开发模式开关：`DEV_MODE=true`（旧版 dev 脚本语义）时前端直接加载
 * artifylab-frontend 的 vite dev server（localhost:5000），无需 build:copy
 * 产物；打包运行时为 false。
 */
export const isDevMode = process.env.DEV_MODE === 'true'

/** 获取应用资源根目录：打包后为 process.resourcesPath，开发环境为项目 assets 目录 */
export function getAppResourcesPath(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets')
}

/**
 * artifylab 前端产物目录：打包后位于 resources/frontend（electron-builder
 * extraResources 从 src/main/artifylab/public/frontend 复制），开发环境直接
 * 读源码目录（artifylab-frontend 的 build:copy 写入）。
 */
export function getFrontendPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'frontend')
    : path.join(app.getAppPath(), 'src', 'main', 'artifylab', 'public', 'frontend')
}
