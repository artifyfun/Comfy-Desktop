/**
 * 技能部署到 codex 临时 CODEX_HOME——agentRuntime 与 service 共用
 * （agentRuntime 创建会话时部署一次；service decide 每轮热刷新一次）。
 */
import { defaultSkillLibrary } from './skillStore'
import { logger } from '../utils/logger'

export function deployWorkbenchSkills(codexHome: string): void {
  try {
    defaultSkillLibrary().deployTo(codexHome)
  } catch (e) {
    logger.warn('workbench skills deploy failed', e)
  }
}
