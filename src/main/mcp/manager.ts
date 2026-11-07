import os from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { augmentPath } from '../sandbox/env'
import { readProjectMcp } from '../project'
import type { ToolDefinition } from '../tools/types'
import type { McpConfig, McpServerConfig, McpServerStatus, McpToolInfo } from './types'

const CLIENT_INFO = { name: 'cybertiger', version: '1.0.0' }

/** 从 MCP 拿到的工具原始定义 */
interface RemoteTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface ServerEntry {
  /** server 名;与 scope 一起构成 Map 的键 */
  name: string
  /** '' 为全局(设置页那一份),其余是工作空间的 `.cybertiger/mcp.json` */
  scope: string
  config: McpServerConfig
  configKey: string
  state: McpServerStatus['state']
  error?: string
  client: Client | null
  transport: Transport | null
  tools: RemoteTool[]
}

/**
 * 打包后的 macOS / Linux 应用 PATH 只有系统目录,npx / uvx 等命令找不到。
 * 在 SDK 默认环境基础上追加常见的用户级 bin 目录 —— 那份清单与受限执行用的是同一份
 * (`sandbox/env.ts`),少一个目录就是沙箱里 `npm` 一律 127。
 */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env = { ...getDefaultEnvironment(), ...extra }
  env.PATH = augmentPath(env.PATH ?? '', os.homedir())
  return env
}

/** OpenAI 要求函数名匹配 ^[a-zA-Z0-9_-]{1,64}$ */
function sanitizeToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** 把 callTool 返回的内容块拼成给模型看的文本 */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content)
  }
  return content
    .map((block: { type?: string; text?: string; mimeType?: string }) => {
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'image') return `[图片 ${block.mimeType ?? ''}]`
      if (block.type === 'audio') return `[音频 ${block.mimeType ?? ''}]`
      if (block.type === 'resource') return '[资源]'
      return `[${block.type ?? 'unknown'}]`
    })
    .join('\n')
}

/**
 * MCP 连接的生命周期。
 *
 * 全局那一份归设置页管;工作空间那一份来自 `<workspace>/.cybertiger/mcp.json`,
 * 同名 server(以及它提供的同名工具)覆盖全局。同一个 server 名在两个作用域里各开一条连接,
 * 但工具查找按「先全局、后项目」的顺序覆盖 —— 所以项目里的那份赢。
 */
class McpManager {
  /** 键是 `scope\0name`;两个作用域可以各有同名 server */
  private servers = new Map<string, ServerEntry>()
  private listeners = new Set<(statuses: McpServerStatus[]) => void>()

  onStatusChange(listener: (statuses: McpServerStatus[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const statuses = this.getStatus()
    for (const l of this.listeners) l(statuses)
  }

  private key(scope: string, name: string): string {
    return `${scope}\u0000${name}`
  }

  /** 设置页只看全局那一份;项目级状态不进它的列表 */
  getStatus(): McpServerStatus[] {
    const statuses: McpServerStatus[] = []
    for (const entry of this.servers.values()) {
      if (entry.scope !== '') continue
      statuses.push({
        name: entry.name,
        state: entry.state,
        error: entry.error,
        tools: entry.tools.map((t): McpToolInfo => ({ name: t.name, description: t.description }))
      })
    }
    return statuses
  }

  /**
   * 按新配置增量重连全局 server:未变的保留,删除或变更的关闭,新增或变更且未禁用的异步连接。
   * 返回时连接可能仍在进行,状态通过 onStatusChange 推送。
   */
  async reload(config: McpConfig): Promise<void> {
    await this.reloadScope('', config.mcpServers)
  }

  /**
   * 读工作空间的 `.cybertiger/mcp.json` 并同步那一层连接。
   * 每次进入工作空间、以及每次 run 开始时调用;文件没变时这条路径什么都不做。
   */
  async ensureWorkspace(workspace: string): Promise<void> {
    const scope = workspace.trim()
    if (!scope) return
    const { config, error } = readProjectMcp(scope)
    if (error) console.error('[mcp] 项目配置被忽略:', error)
    await this.reloadScope(scope, config?.mcpServers ?? {})
  }

  /** 关闭某个工作空间的项目连接(会话换目录且没有别处用到时由调用方决定是否用) */
  async closeWorkspace(workspace: string): Promise<void> {
    const scope = workspace.trim()
    if (!scope) return
    await Promise.all(
      [...this.servers.entries()]
        .filter(([, entry]) => entry.scope === scope)
        .map(([key]) => this.closeServer(key))
    )
    this.notify()
  }

  private async reloadScope(scope: string, next: Record<string, McpServerConfig>): Promise<void> {
    const closing: Promise<void>[] = []

    for (const [key, entry] of this.servers) {
      if (entry.scope !== scope) continue
      const nextConfig = next[entry.name]
      if (!nextConfig || JSON.stringify(nextConfig) !== entry.configKey) {
        closing.push(this.closeServer(key))
      }
    }
    await Promise.all(closing)

    for (const [name, serverConfig] of Object.entries(next)) {
      const key = this.key(scope, name)
      if (this.servers.has(key)) continue
      const entry: ServerEntry = {
        name,
        scope,
        config: serverConfig,
        configKey: JSON.stringify(serverConfig),
        state: serverConfig.disabled ? 'disabled' : 'connecting',
        client: null,
        transport: null,
        tools: []
      }
      this.servers.set(key, entry)
      if (!serverConfig.disabled) void this.connect(key, entry)
    }
    this.notify()
  }

  /** 用当前配置强制重连全部全局 server */
  async reconnectAll(config: McpConfig): Promise<void> {
    await this.closeAll()
    await this.reload(config)
  }

  private async connect(key: string, entry: ServerEntry): Promise<void> {
    const label = entry.scope ? `${entry.scope}/${entry.name}` : entry.name
    try {
      const transport = this.createTransport(entry.config)
      const client = new Client(CLIENT_INFO)
      entry.transport = transport
      entry.client = client
      await client.connect(transport)
      const { tools } = await client.listTools()
      // 连接期间该 server 可能已被 reload 移除或替换
      if (this.servers.get(key) !== entry) {
        await client.close().catch(() => undefined)
        return
      }
      entry.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>
      }))
      entry.state = 'connected'
      entry.error = undefined
    } catch (error) {
      if (this.servers.get(key) !== entry) return
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : String(error)
      entry.tools = []
      await entry.client?.close().catch(() => undefined)
      entry.client = null
      entry.transport = null
      console.error(`[mcp] ${label} 连接失败:`, entry.error)
    }
    this.notify()
  }

  private createTransport(config: McpServerConfig): Transport {
    if ('command' in config) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: buildEnv(config.env),
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (chunk: Buffer) => {
        console.error(`[mcp:${config.command}] ${chunk.toString().trimEnd()}`)
      })
      return transport
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined
    })
  }

  private async closeServer(key: string): Promise<void> {
    const entry = this.servers.get(key)
    if (!entry) return
    this.servers.delete(key)
    await entry.client?.close().catch((error) => {
      console.error(`[mcp] ${entry.name} 关闭失败:`, error)
    })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((key) => this.closeServer(key)))
    this.notify()
  }

  /**
   * 把已连接 server 的工具映射为内置工具定义,供注册表合并。
   * 传了工作空间就叠上该作用域的工具,同名工具由项目那一份覆盖。
   */
  getTools(scope = ''): ToolDefinition[] {
    const byName = new Map<string, ToolDefinition>()
    const add = (entry: ServerEntry): void => {
      if (entry.state !== 'connected' || !entry.client) return
      for (const t of entry.tools) {
        const name = sanitizeToolName(entry.name, t.name)
        byName.set(name, {
          name,
          description: t.description
            ? `[${entry.name}] ${t.description}`
            : `[${entry.name}] ${t.name}`,
          parameters: t.inputSchema,
          execute: (args) => this.callTool(entry, t.name, args)
        })
      }
    }
    for (const entry of this.servers.values()) if (entry.scope === '') add(entry)
    const trimmed = scope.trim()
    if (trimmed) {
      for (const entry of this.servers.values()) if (entry.scope === trimmed) add(entry)
    }
    return [...byName.values()]
  }

  private async callTool(
    entry: ServerEntry,
    tool: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (!entry.client || entry.state !== 'connected') {
      throw new Error(`MCP server ${entry.name} 未连接`)
    }
    const result = await entry.client.callTool({ name: tool, arguments: args })
    // SDK 返回类型兼容旧协议:新协议是 content 数组,旧协议是 toolResult
    const payload = 'content' in result ? result.content : result.toolResult
    const text = contentToText(payload)
    if (result.isError) throw new Error(text || '工具执行失败')
    return text
  }
}

export const mcpManager = new McpManager()
