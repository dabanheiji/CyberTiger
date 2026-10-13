import fs from 'node:fs'
import path from 'node:path'
import {
  STALE_RESULT_PLACEHOLDER,
  buildHistory,
  skillsCatalog,
  toChatMessage,
  toIdentifiedMessages
} from '../../../src/main/agent/history'
import { SUMMARY_BLOCK_PREFIX, isSummaryBlock, summaryBlock } from '../../../src/main/agent/compact'
import { SYSTEM_PROMPT } from '../../../src/main/agent/prompt'
import { skillRegistry } from '../../../src/main/skills/registry'
import { agentRegistry } from '../../../src/main/agents/registry'
import { resetSettings, setSettings } from '../../helpers/settings'
import { makeMessage, toolDef } from '../../helpers/fixtures'
import {
  agentDoc,
  makeTempDir,
  releaseCatalog,
  removeTempDir,
  skillDoc,
  useCatalog,
  writeFiles
} from '../../helpers/temp'

const skillNames = ['route-planner', 'weather-report']

let skillsDir = ''
let agentsDir = ''

/** 写一个 skill 目录并立刻重扫;registry 以磁盘为唯一事实来源 */
function addSkill(name: string, description: string, body?: string): void {
  writeFiles(skillsDir, { [`${name}/SKILL.md`]: skillDoc(name, description, body) })
  skillRegistry.scan()
}

function addAgent(name: string, description: string, extra = ''): void {
  writeFiles(agentsDir, { [`${name}/AGENT.md`]: agentDoc(name, description, undefined, extra) })
  agentRegistry.scan()
}

beforeEach(() => {
  skillsDir = makeTempDir()
  agentsDir = makeTempDir()
  useCatalog(skillsDir, agentsDir)
  resetSettings()
  skillRegistry.scan()
  agentRegistry.scan()
})

afterEach(() => {
  releaseCatalog()
  removeTempDir(skillsDir)
  removeTempDir(agentsDir)
  resetSettings()
})

describe('system prompt 里的目录注入', () => {
  it('没有任何 skill 与自定义角色时只有基础提示词', () => {
    const history = buildHistory([], [])
    expect(history).toEqual([{ role: 'system', content: SYSTEM_PROMPT }])
  })

  it('启用的 skill 以 name: description 进入目录', () => {
    addSkill(skillNames[0], '规划两点之间的驾车路线')
    addSkill(skillNames[1], '查询城市天气')
    const history = buildHistory([], [])
    const system = history[0].content as string
    expect(system).toContain('## 可用 Skills')
    // 按名字排序,目录顺序稳定可预期
    expect(system.indexOf('route-planner')).toBeLessThan(system.indexOf('weather-report'))
    expect(system).toContain('- route-planner: 规划两点之间的驾车路线')
    expect(history).toHaveLength(1)
  })

  it('被禁用的 skill 不进目录', () => {
    addSkill(skillNames[0], '规划路线')
    addSkill(skillNames[1], '查询天气')
    setSettings({ disabledSkills: [skillNames[1]] })
    skillRegistry.scan()
    expect(skillsCatalog()).toContain(skillNames[0])
    expect(skillsCatalog()).not.toContain(skillNames[1])
  })

  it('解析失败的 skill 不进目录,也不影响其他 skill', () => {
    addSkill(skillNames[0], '规划路线')
    writeFiles(skillsDir, { 'broken/SKILL.md': '没有 frontmatter 的正文' })
    skillRegistry.scan()
    expect(skillsCatalog()).toContain(skillNames[0])
    expect(skillsCatalog()).not.toContain('broken')
    expect(skillRegistry.list().find((s) => s.name === 'broken')).toMatchObject({
      enabled: false,
      error: expect.any(String)
    })
  })

  it('自定义子 Agent 角色进目录,内置通用角色不列', () => {
    addAgent('researcher', '只做资料检索')
    const system = buildHistory([], [])[0].content as string
    expect(system).toContain('## 可用子 Agent')
    expect(system).toContain('- researcher: 只做资料检索')
    // generic 是 agent 参数缺省时的默认角色,列出来只会诱导模型显式选它
    expect(system).not.toContain('- generic:')
  })

  it('禁用或解析失败的角色不进目录', () => {
    addAgent('researcher', '只做资料检索')
    addAgent('coder', '写代码')
    writeFiles(agentsDir, { 'broken/AGENT.md': '缺 description' })
    setSettings({ disabledAgents: ['coder'] })
    agentRegistry.scan()
    const system = buildHistory([], [])[0].content as string
    expect(system).toContain('researcher')
    expect(system).not.toContain('coder')
    expect(system).not.toContain('broken')
  })

  it('enableSubAgent 为 false 时收起角色目录,skill 目录照旧', () => {
    addSkill(skillNames[0], '规划路线')
    addAgent('researcher', '只做资料检索')
    setSettings({ enableSubAgent: false })
    const system = buildHistory([], [])[0].content as string
    expect(system).not.toContain('## 可用子 Agent')
    expect(system).toContain('## 可用 Skills')
  })

  it('enableSubAgent 未设置按允许处理', () => {
    addAgent('researcher', '只做资料检索')
    expect(buildHistory([], [])[0].content).toContain('## 可用子 Agent')
  })
})

describe('历史里易变工具的结果', () => {
  const assistantWithCall = (id: string, name: string): ReturnType<typeof makeMessage> =>
    makeMessage({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name, arguments: '{}' }]
    })

  it('易变工具的旧结果替换为占位,位置不变', () => {
    const messages = [
      makeMessage({ role: 'user', content: '现在几点了' }),
      assistantWithCall('c1', 'get_current_time'),
      makeMessage({ role: 'tool', tool_call_id: 'c1', content: '{"iso":"2026-10-08T12:00:00Z"}' }),
      makeMessage({ role: 'assistant', content: '现在是 12 点' })
    ]
    const history = buildHistory(messages, [toolDef('get_current_time', true)])
    expect(history.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant'])
    expect(history[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: STALE_RESULT_PLACEHOLDER
    })
  })

  it('不易变的工具结果原样回放', () => {
    const messages = [
      assistantWithCall('c1', 'read_skill_file'),
      makeMessage({ role: 'tool', tool_call_id: 'c1', content: '指南正文' })
    ]
    const history = buildHistory(messages, [toolDef('read_skill_file')])
    expect(history[2].content).toBe('指南正文')
  })

  it('同一 run 内多个调用各自按工具名判断', () => {
    const messages = [
      makeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', name: 'get_current_time', arguments: '{}' },
          { id: 'b', name: 'load_skill', arguments: '{}' }
        ]
      }),
      makeMessage({ role: 'tool', tool_call_id: 'a', content: '旧时间' }),
      makeMessage({ role: 'tool', tool_call_id: 'b', content: '技能正文' })
    ]
    const history = buildHistory(messages, [
      toolDef('get_current_time', true),
      toolDef('load_skill')
    ])
    expect(history[2].content).toBe(STALE_RESULT_PLACEHOLDER)
    expect(history[3].content).toBe('技能正文')
  })

  it('找不到对应 assistant 调用的 tool 行不猜测工具名,原样保留', () => {
    const history = buildHistory(
      [makeMessage({ role: 'tool', tool_call_id: 'orphan', content: '孤儿结果' })],
      [toolDef('get_current_time', true)]
    )
    expect(history[1].content).toBe('孤儿结果')
  })

  it('本轮工具快照里没有的同名工具按不易变处理', () => {
    // 子 Agent 的工具集是裁剪过的快照:判断不了就不动别人的结果
    const messages = [
      assistantWithCall('c1', 'get_current_time'),
      makeMessage({ role: 'tool', tool_call_id: 'c1', content: '旧时间' })
    ]
    expect(buildHistory(messages, [])[2].content).toBe('旧时间')
  })

  it('占位文案只做陈述,不带"请重新调用"这类指令语气', () => {
    // 实测:祈使句会被模型当成本轮待办,把整轮话题从用户的问题带到重查时间上
    expect(STALE_RESULT_PLACEHOLDER).toBe('[历史调用,结果已省略]')
    expect(STALE_RESULT_PLACEHOLDER).not.toMatch(/请|建议|需要|应当|重新/)
  })
})

describe('单条消息转协议消息', () => {
  it('内容、思考、调用三者全空的占位行返回 null', () => {
    expect(toChatMessage(makeMessage({ role: 'assistant' }))).toBeNull()
  })

  it('只有思考没有正文也没有调用的行同样返回 null', () => {
    // reasoning 不属于 OpenAI 协议字段,回放时不带回去,这种行也就没有可播内容
    expect(toChatMessage(makeMessage({ role: 'assistant', reasoning: '想了一路' }))).toBeNull()
  })

  it('只有工具调用的 assistant 行把 content 置为 null 并带上调用', () => {
    const converted = toChatMessage(
      makeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'get_current_time', arguments: '{"tz":"local"}' }]
      })
    )
    expect(converted).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_current_time', arguments: '{"tz":"local"}' }
        }
      ]
    })
  })

  it('有正文时不带 tool_calls 字段', () => {
    expect(toChatMessage(makeMessage({ role: 'assistant', content: '答' }))).toEqual({
      role: 'assistant',
      content: '答'
    })
  })

  it('tool 行保留 tool_call_id,system 与 user 行原样', () => {
    expect(toChatMessage(makeMessage({ role: 'tool', tool_call_id: 'c9', content: 'r' }))).toEqual({
      role: 'tool',
      tool_call_id: 'c9',
      content: 'r'
    })
    expect(toChatMessage(makeMessage({ role: 'system', content: 's' }))).toEqual({
      role: 'system',
      content: 's'
    })
    expect(toChatMessage(makeMessage({ role: 'user', content: 'u' }))).toEqual({
      role: 'user',
      content: 'u'
    })
  })
})

describe('/ 触发的 skill 展开', () => {
  it('把正文与用户输入合并成一条 user 消息', () => {
    addSkill(skillNames[0], '规划路线', '为 $ARGUMENTS 规划最短路线')
    const converted = toChatMessage(
      makeMessage({ role: 'user', skill: skillNames[0], content: '从 A 到 B' })
    )
    expect(converted).toEqual({
      role: 'user',
      content: '[Skill: route-planner]\n为 从 A 到 B 规划最短路线'
    })
  })

  it('正文没有占位符时把用户输入追加在末尾', () => {
    addSkill(skillNames[0], '规划路线', '固定步骤说明')
    const converted = toChatMessage(
      makeMessage({ role: 'user', skill: skillNames[0], content: '从 A 到 B' })
    )
    expect(converted?.content).toContain('固定步骤说明\n\n用户输入:\n从 A 到 B')
  })

  it('空输入不追加"用户输入"段', () => {
    addSkill(skillNames[0], '规划路线', '固定步骤说明')
    expect(
      toChatMessage(makeMessage({ role: 'user', skill: skillNames[0], content: '  ' }))
    ).toEqual({ role: 'user', content: '[Skill: route-planner]\n固定步骤说明' })
  })

  it('skill 已被删除时退化为普通消息,不中断对话', () => {
    // 落库时的 skill 名可能早已不在磁盘上(用户删了目录)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.rmSync(path.join(skillsDir, skillNames[0]), { recursive: true, force: true })
    skillRegistry.scan()
    expect(
      toChatMessage(makeMessage({ role: 'user', skill: skillNames[0], content: '原话' }))
    ).toEqual({ role: 'user', content: '原话' })
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('skill 被禁用时同样退化', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    addSkill(skillNames[0], '规划路线')
    setSettings({ disabledSkills: [skillNames[0]] })
    skillRegistry.scan()
    expect(
      toChatMessage(makeMessage({ role: 'user', skill: skillNames[0], content: '原话' }))
    ).toEqual({ role: 'user', content: '原话' })
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('展开 route-planner 失败'),
      expect.objectContaining({ message: expect.stringContaining('已被禁用') })
    )
  })

  it('展开后的 skill 消息仍然是本次请求的最后一条 user 消息', () => {
    addSkill(skillNames[0], '规划路线', '为 $ARGUMENTS 规划')
    const history = buildHistory(
      [
        makeMessage({ role: 'user', content: '上一条' }),
        makeMessage({ role: 'user', skill: skillNames[0], content: '从 A 到 B' })
      ],
      []
    )
    expect(history.at(-1)?.content).toContain('[Skill: route-planner]')
  })
})

describe('摘要块作为固定头部', () => {
  const oneTurn = (): ReturnType<typeof makeMessage>[] => [
    makeMessage({ role: 'user', content: '继续刚才的事' })
  ]

  it('有摘要时它排在 system 之后、历史之前', () => {
    const history = buildHistory(oneTurn(), [], '用户此前在查中牟到汝阳的路线')
    expect(history.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect(String(history[1].content)).toContain(SUMMARY_BLOCK_PREFIX)
    expect(String(history[1].content)).toContain('用户此前在查中牟到汝阳的路线')
    expect(String(history[2].content)).toBe('继续刚才的事')
  })

  it('摘要为空或只有空白时不插空块:一条没有内容的 user 消息会被模型当成新提问', () => {
    expect(buildHistory(oneTurn(), [], '').map((m) => m.role)).toEqual(['system', 'user'])
    expect(buildHistory(oneTurn(), [], '   \n ').map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('位置只认「紧跟 system 的那一条」:排到历史后面或换成 assistant 都不算', () => {
    expect(isSummaryBlock(summaryBlock('正文'))).toBe(true)
    expect(isSummaryBlock(undefined)).toBe(false)
    expect(isSummaryBlock({ role: 'user', content: '普通提问' })).toBe(false)
    expect(isSummaryBlock({ role: 'assistant', content: SUMMARY_BLOCK_PREFIX })).toBe(false)
  })

  it('标记行只陈述,不带「请回应 / 重新调用」这类祈使', () => {
    // 这块以 user 角色出现在请求里,形似一条新提问;写成祈使句模型就会去执行它
    expect(SUMMARY_BLOCK_PREFIX).not.toMatch(/请|需要|应当|必须|重新/)
  })
})

describe('toIdentifiedMessages 给摘要用', () => {
  it('每条转换结果带着自己那行的 id:水位才有落点', () => {
    const items = toIdentifiedMessages(
      [
        makeMessage({ id: 'm1', role: 'user', content: '问' }),
        makeMessage({ id: 'm2', role: 'assistant', content: '答' })
      ],
      []
    )
    expect(items.map((i) => i.id)).toEqual(['m1', 'm2'])
  })

  it('全空的占位行不产出条目,id 也不会因此留个空洞', () => {
    const items = toIdentifiedMessages(
      [
        makeMessage({ id: 'm1', role: 'user', content: '问' }),
        makeMessage({ id: 'm2', role: 'assistant', content: '', reasoning: '只想了一半' }),
        makeMessage({ id: 'm3', role: 'assistant', content: '答' })
      ],
      []
    )
    expect(items.map((i) => i.id)).toEqual(['m1', 'm3'])
  })

  it('与 buildHistory 转出同一份内容:回放与摘要永不分叉', () => {
    const messages = [
      makeMessage({ id: 'm1', role: 'user', content: '现在几点' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'get_current_time', arguments: '{}' }]
      }),
      makeMessage({ id: 'm3', role: 'tool', tool_call_id: 'c1', content: '12:00' })
    ]
    const defs = [toolDef('get_current_time', true)]
    expect(toIdentifiedMessages(messages, defs).map((i) => i.message)).toEqual(
      buildHistory(messages, defs).slice(1)
    )
  })
})
