import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let seq = 0

/**
 * 独立临时工作区。skills / agents 两个 registry 都把目录当唯一事实来源,
 * 测试靠 CYBERTIGER_SKILLS_DIR / CYBERTIGER_AGENTS_DIR 把它们指到这里。
 */
export function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), 'cybertiger-test', `ws-${process.pid}-${Date.now()}-${++seq}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 按 { 相对路径 → 内容 } 批量落文件,自动补父目录 */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
}

/** 一个最小合法 SKILL.md */
export function skillDoc(name: string, description: string, body = `# ${name} 的使用步骤`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/** 一个最小合法 AGENT.md */
export function agentDoc(
  name: string,
  description: string,
  systemPrompt = `你是 ${name}。`,
  extra = ''
): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${systemPrompt}\n`
}

/** 指向临时工作区,并让两个 registry 重新扫描 */
export function useCatalog(skillsDir: string, agentsDir: string): void {
  process.env.CYBERTIGER_SKILLS_DIR = skillsDir
  process.env.CYBERTIGER_AGENTS_DIR = agentsDir
}

export function releaseCatalog(): void {
  delete process.env.CYBERTIGER_SKILLS_DIR
  delete process.env.CYBERTIGER_AGENTS_DIR
}
