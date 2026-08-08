import { app } from 'electron';
import path from 'node:path';

/** 获取应用资源根目录：打包后为 process.resourcesPath，开发环境为项目 assets 目录 */
export function getAppResourcesPath(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets');
}

/**
 * artifylab 前端产物目录：打包后位于 resources/frontend（electron-builder
 * extraResources 从 src/main/artifylab/public/frontend 复制），开发环境直接
 * 读源码目录（artifylab-frontend 的 build:copy 写入）。
 */
export function getFrontendPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'frontend')
    : path.join(app.getAppPath(), 'src', 'main', 'artifylab', 'public', 'frontend');
}
