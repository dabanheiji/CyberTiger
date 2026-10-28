import { agentRegistry } from '../../src/main/agents/registry'
import { hookRegistry } from '../../src/main/hooks/registry'
import { getAllTools } from '../../src/main/tools/registry'
import { mcpManager } from '../../src/main/mcp/manager'
import { skillRegistry } from '../../src/main/skills/registry'
import { store } from '../../src/main/store'
import { app } from 'electron'

/**
 * 阶段 0 的真正验收标准:主进程模块能在没有 Electron 的前提下被**真导入**。
 * tools/registry 会连带拉起 skills 与 mcp 两条依赖链,store 又在模块顶层就实例化,
 * 所以这条测试同时是「替身面是否够用」的探测器 —— 业务代码新用某个 Electron API 时,
 * 它会以 import 失败的形态第一时间报出来,而不是在某个用例里莫名 undefined。
 */
describe('Electron 替身', () => {
  it('主进程模块可在 Node 侧导入', () => {
    expect(typeof skillRegistry.scan).toBe('function')
    expect(typeof agentRegistry.scan).toBe('function')
    // 只 import registry 而不 import hooks/controller:替身里没有 shell
    expect(typeof hookRegistry.scan).toBe('function')
    expect(store.get('disabledSkills')).toBeUndefined()
  })

  it('app.getPath 返回测试专用目录,不碰真实 userData', () => {
    expect(app.getPath('userData')).toContain('cybertiger-test')
    expect(app.getPath('temp')).toContain('cybertiger-test')
  })

  it('内置工具可被枚举,MCP 未连接时不贡献工具', () => {
    const names = getAllTools().map((t) => t.name)
    expect(names).toContain('get_current_time')
    expect(names).toContain('load_skill')
    expect(names).toContain('read_skill_file')
    expect(mcpManager.getTools()).toEqual([])
  })
})
