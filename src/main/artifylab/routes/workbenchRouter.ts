/**
 * 工作台路由装配（workbench-plan.md §4，v2 扩展见 workbench-plan-v2.md §2.5）。
 *
 * 候选④批一：42 条路由按资源域拆到 routes/workbench/ 下 7 个文件
 * （templates+debug / sessions / presets / skills / catalog / favorites /
 * execute），本文件只做挂载装配——路由表即目录。
 *
 * - GET  /api/workbench/templates        模板清单（含元数据与模型可用性）
 * - GET  /api/workbench/sessions         会话列表（?archived=true 过滤归档）
 * - POST /api/workbench/sessions/create  建会话（title + presetId）
 * - GET  /api/workbench/presets          预设清单 + 默认预设
 * - GET  /api/workbench/skills           技能库清单（Agent Skills 开放标准）
 * - POST /api/workbench/agent/run        AG-UI SSE 决策→执行（routes/agui.ts，唯一管线）
 * - POST /api/workbench/run-workflow     L2：粘贴 workflow JSON 直接执行
 * - POST /api/workbench/publish          固化成 app
 */
import express from 'express'
import { registerTemplatesRoutes } from './workbench/templatesMisc'
import { registerSessionsRoutes } from './workbench/sessions'
import { registerPresetsRoutes } from './workbench/presets'
import { registerSkillsRoutes } from './workbench/skills'
import { registerCatalogRoutes } from './workbench/catalog'
import { registerFavoritesRoutes } from './workbench/favorites'
import { registerExecuteRoutes } from './workbench/execute'

export function createWorkbenchRouter(): express.Router {
  const router = express.Router()
  registerTemplatesRoutes(router)
  registerSessionsRoutes(router)
  registerPresetsRoutes(router)
  registerSkillsRoutes(router)
  registerCatalogRoutes(router)
  registerFavoritesRoutes(router)
  registerExecuteRoutes(router)
  return router
}
