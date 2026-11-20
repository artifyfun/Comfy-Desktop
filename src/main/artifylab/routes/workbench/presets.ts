import type express from 'express'
import { HTTP_STATUS } from '../../config/constants'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'

import { workbenchService } from '../../workbench/service'

export function registerPresetsRoutes(router: express.Router): void {
  router.get('/api/workbench/presets', (_req, res) => {
    res.json(
      createSuccessResponse({
        presets: workbenchService.listPresets(),
        default: workbenchService.getDefaultPresetId()
      })
    )
  })

  router.post('/api/workbench/presets/create', (req, res) => {
    const { from, id, name } = req.body as { from?: string; id?: string; name?: string }
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    try {
      res
        .status(HTTP_STATUS.CREATED)
        .json(createSuccessResponse(workbenchService.createPreset({ from, id, name })))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'invalid preset'))
    }
  })

  router.post('/api/workbench/presets/delete', (req, res) => {
    const { id } = req.body as { id?: string }
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    const ok = workbenchService.deletePreset(id)
    if (!ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('builtin or unknown preset'))
      return
    }
    res.json(createSuccessResponse({ deleted: true }))
  })

  router.post('/api/workbench/presets/default', (req, res) => {
    const { id } = req.body as { id?: string }
    if (!id || !workbenchService.setDefaultPreset(id)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('unknown preset'))
      return
    }
    res.json(createSuccessResponse({ default: id }))
  })

  // 预设捆绑模板（可执行推荐池）
  router.post('/api/workbench/presets/templates', (req, res) => {
    const { id, templateIds } = req.body as { id?: string; templateIds?: string[] }
    if (!id || !Array.isArray(templateIds)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id and templateIds required'))
      return
    }
    try {
      res.json(createSuccessResponse(workbenchService.updatePresetTemplates(id, templateIds)))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'update failed'))
    }
  })

  // 预设捆绑技能（SKILL.md 知识技能 name 清单）
  router.post('/api/workbench/presets/skills', (req, res) => {
    const { id, skillIds } = req.body as { id?: string; skillIds?: string[] }
    if (!id || !Array.isArray(skillIds)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id and skillIds required'))
      return
    }
    try {
      res.json(createSuccessResponse(workbenchService.updatePresetSkills(id, skillIds)))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'update failed'))
    }
  })

  // ---------------- 技能库（Agent Skills 开放标准）与模型 ----------------

  // 技能清单（内置 + 用户，含 token/enabled/source/valid）
}
