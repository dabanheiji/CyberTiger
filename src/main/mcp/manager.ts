import os from 'os'
import path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
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
  config: McpServerConfig
  configKey: string
  state: McpServerStatus['state']
  error?: string
  client: Client | null
  transport: Transport | null
  tools: RemoteTool[]
}

/** 暴露给模型的工具名 → 来源 */
interface ToolSource {
  server: string
  tool: string
}

/**
 * 打包后的 macOS / Linux 应用 PATH 只有系统目录,npx / uvx 等命令找不到。
 * 在 SDK 默认环境基础上追加常见的用户级 bin 目录。
 */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env = { ...getDefaultEnvironment(), ...extra }
  if (process.platform !== 'win32') {
    const home = os.homedir()
    const candidates = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.nvm', 'current', 'bin'),
      path.join(home, '.volta', 'bin')
    ]
    const current = (env.PATH ?? '').split(':').filter(Boolean)
    for (const dir of candidates) {
      if (!current.includes(dir)) current.push(dir)
    }
    env.PATH = current.join(':')
  }
  return env
}

/** OpenAI 要求函数名匹配 ^[a-zA-Z0-9_-]{1,64}$ */
function sanitizeToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** 把 callTool 返回的内容块拼成给模型看的文本 */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content)
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

class McpManager {
  private servers = new Map<string, ServerEntry>()
  /** 清洗后的工具名 → 来源,供 execute 反查 */
  private toolSources = new Map<string, ToolSource>()
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

  getStatus(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      state: s.state,
      error: s.error,
      tools: s.tools.map((t): McpToolInfo => ({ name: t.name, description: t.description }))
    }))
  }

  /**
   * 按新配置增量重连:未变的保留,删除或变更的关闭,新增或变更且未禁用的异步连接。
   * 返回时连接可能仍在进行,状态通过 onStatusChange 推送。
   */
  async reload(config: McpConfig): Promise<void> {
    const next = config.mcpServers
    const closing: Promise<void>[] = []

    for (const [name, entry] of this.servers) {
      const nextConfig = next[name]
      if (!nextConfig || JSON.stringify(nextConfig) !== entry.configKey) {
        closing.push(this.closeServer(name))
      }
    }
    await Promise.all(closing)

    for (const [name, serverConfig] of Object.entries(next)) {
      if (this.servers.has(name)) continue
      const entry: ServerEntry = {
        config: serverConfig,
        configKey: JSON.stringify(serverConfig),
        state: serverConfig.disabled ? 'disabled' : 'connecting',
        client: null,
        transport: null,
        tools: []
      }
      this.servers.set(name, entry)
      if (!serverConfig.disabled) void this.connect(name, entry)
    }
    this.notify()
  }

  /** 用当前配置强制重连全部 server */
  async reconnectAll(config: McpConfig): Promise<void> {
    await this.closeAll()
    await this.reload(config)
  }

  private async connect(name: string, entry: ServerEntry): Promise<void> {
    try {
      const transport = this.createTransport(entry.config)
      const client = new Client(CLIENT_INFO)
      entry.transport = transport
      entry.client = client
      await client.connect(transport)
      const { tools } = await client.listTools()
      // 连接期间该 server 可能已被 reload 移除或替换
      if (this.servers.get(name) !== entry) {
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
      this.rebuildToolIndex()
    } catch (error) {
      if (this.servers.get(name) !== entry) return
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : String(error)
      entry.tools = []
      await entry.client?.close().catch(() => undefined)
      entry.client = null
      entry.transport = null
      console.error(`[mcp] ${name} 连接失败:`, entry.error)
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

  private async closeServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    this.servers.delete(name)
    await entry.client?.close().catch((error) => {
      console.error(`[mcp] ${name} 关闭失败:`, error)
    })
    this.rebuildToolIndex()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.closeServer(name)))
    this.notify()
  }

  private rebuildToolIndex(): void {
    this.toolSources.clear()
    for (const [server, entry] of this.servers) {
      for (const t of entry.tools) {
        this.toolSources.set(sanitizeToolName(server, t.name), { server, tool: t.name })
      }
    }
  }

  /** 把已连接 server 的工具映射为内置工具定义,供注册表合并 */
  getTools(): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const [server, entry] of this.servers) {
      if (entry.state !== 'connected' || !entry.client) continue
      for (const t of entry.tools) {
        const name = sanitizeToolName(server, t.name)
        defs.push({
          name,
          description: t.description ? `[${server}] ${t.description}` : `[${server}] ${t.name}`,
          parameters: t.inputSchema,
          execute: (args) => this.callTool(name, args)
        })
      }
    }
    return defs
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const source = this.toolSources.get(name)
    if (!source) throw new Error(`工具 ${name} 已不可用`)
    const entry = this.servers.get(source.server)
    if (!entry?.client || entry.state !== 'connected') {
      throw new Error(`MCP server ${source.server} 未连接`)
    }
    const result = await entry.client.callTool({ name: source.tool, arguments: args })
    // SDK 返回类型兼容旧协议:新协议是 content 数组,旧协议是 toolResult
    const payload = 'content' in result ? result.content : result.toolResult
    const text = contentToText(payload)
    if (result.isError) throw new Error(text || '工具执行失败')
    return text
  }
}

export const mcpManager = new McpManager()
