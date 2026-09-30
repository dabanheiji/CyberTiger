/** skill 的安装来源 */
export type SkillSource =
  | { type: 'local' }
  | { type: 'github'; repo: string; ref?: string; subpath?: string }
  | { type: 'url'; url: string }

/** 已安装(或放入目录)的 skill */
export interface SkillMeta {
  name: string
  description: string
  /** 绝对路径 */
  dir: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  source: SkillSource
  enabled: boolean
  /** SKILL.md 解析失败时的原因;存在时 enabled 固定为 false */
  error?: string
}

/** 安装前从压缩包 / 文件夹里发现的候选 skill */
export interface SkillCandidate {
  name: string
  description: string
  /** 相对解压根目录的路径 */
  relPath: string
  /** 正文前若干字,供安装前预览 */
  bodyPreview: string
  /** 同名 skill 已安装 */
  exists: boolean
  /** 解析失败原因 */
  error?: string
}

/** discover 的结果:候选列表 + 一个用于后续 install 的会话 id */
export interface DiscoverResult {
  sessionId: string
  source: SkillSource
  candidates: SkillCandidate[]
}

export interface InstallResult {
  installed: string[]
}
