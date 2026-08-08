import { app } from 'electron';
import path from 'node:path';

/** 获取应用资源根目录：打包后为 process.resourcesPath，开发环境为项目 assets 目录 */
export function getAppResourcesPath(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets');
}
