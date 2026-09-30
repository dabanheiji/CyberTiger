import type { ToolDefinition } from '../tools/types'
import { skillRegistry } from './registry'

/** 加载 skill 的完整指令 */
export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description:
    '加载一个 skill 的完整指令。当用户的任务与"可用 Skills"列表里某项的描述匹配时,先调用此工具获取该 skill 的详细步骤,再按指令行动。返回 SKILL.md 正文和该 skill 目录下的文件清单。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称,取自可用 Skills 列表' }
    },
    required: ['name']
  },
  execute: (args) => {
    const name = String(args.name ?? '').trim()
    if (!name) throw new Error('缺少 name')
    const body = skillRegistry.readBody(name)
    const files = skillRegistry.listFiles(name).filter((f) => f !== 'SKILL.md')
    const fileList =
      files.length > 0
        ? `\n\n---\n该 skill 附带的文件(可用 read_skill_file 读取):\n${files.map((f) => `- ${f}`).join('\n')}`
        : ''
    return `# Skill: ${name}\n\n${body}${fileList}`
  }
}

/** 读取 skill 目录内的附属文件 */
export const readSkillFileTool: ToolDefinition = {
  name: 'read_skill_file',
  description:
    '读取某个 skill 目录内的文件,例如 references/ 下的参考文档或 assets/ 下的模板。路径相对于 skill 根目录。仅支持文本文件,不能读取 skill 目录之外的内容。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称' },
      path: { type: 'string', description: '相对 skill 根目录的文件路径,例如 references/guide.md' }
    },
    required: ['name', 'path']
  },
  execute: (args) => {
    const name = String(args.name ?? '').trim()
    const relPath = String(args.path ?? '').trim()
    if (!name || !relPath) throw new Error('缺少 name 或 path')
    return skillRegistry.readFile(name, relPath)
  }
}

export const skillTools: ToolDefinition[] = [loadSkillTool, readSkillFileTool]
