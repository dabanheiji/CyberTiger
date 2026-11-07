import fs from 'node:fs'
import path from 'node:path'
import {
  STALE_RESULT_PLACEHOLDER,
  buildHistory,
  skillsCatalog,
  systemPromptMessage,
  toChatMessage,
  toIdentifiedMessages
} from '../../../src/main/agent/history'
import { SUMMARY_BLOCK_PREFIX, isSummaryBlock, summaryBlock } from '../../../src/main/agent/compact'
import {
  SUB_AGENT_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  modelNote,
  workspaceNote
} from '../../../src/main/agent/prompt'
import { MAIN_AGENT_MAX_STEPS } from '../../../src/main/agent/loop'
import { SUB_AGENT_MAX_STEPS, SUB_AGENT_RESULT_MAX } from '../../../src/main/agent/task'
import { MAX_JOBS_PER_CONVERSATION, MAX_JOBS_TOTAL } from '../../../src/main/process/jobs'
import { readFileTool, writeFileTool } from '../../../src/main/tools/files'
import { runCommandTool } from '../../../src/main/tools/shell'
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
  it('没有任何 skill 与自定义角色时仍保留空目录:模型要知道 skill 这一层存在', () => {
    const history = buildHistory([], [])
    const system = history[0].content as string
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true)
    expect(system).toContain('## 可用 Skills')
    expect(system).toContain('本会话可用 Skills:0 个')
    expect(system).not.toContain('## 可用子 Agent')
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

  it('项目级 skill 也进目录:带工作空间时合并 .cybertiger/skills,同名覆盖全局', () => {
    addSkill('shared', '全局那一份')
    const ws = makeTempDir()
    try {
      writeFiles(ws, {
        '.cybertiger/skills/shared/SKILL.md': skillDoc('shared', '项目那一份'),
        '.cybertiger/skills/extra/SKILL.md': skillDoc('extra', '只在项目里')
      })
      const catalog = skillsCatalog(ws)
      expect(catalog).toContain('- extra: 只在项目里(项目)')
      expect(catalog).toContain('- shared: 项目那一份(项目)')
      expect(catalog).not.toContain('全局那一份')
    } finally {
      removeTempDir(ws)
    }
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

describe('system prompt 里的工作空间', () => {
  it('选了目录就把它写进 system,并说清相对路径按它解析', () => {
    const content = systemPromptMessage('/Users/dev/code/shop').content as string
    expect(content).toContain('## 本次会话的工作空间')
    expect(content).toContain('/Users/dev/code/shop')
    expect(content).toContain('相对路径')
  })

  it('没选目录时那一段整块不出现:提一个不存在的工作空间会让模型凭空编路径', () => {
    const content = systemPromptMessage().content as string
    // 基础提示词里审批那句会提到「工作空间」这个词,所以断言的是那一段标题与实际路径
    expect(content).not.toContain('## 本次会话的工作空间')
    expect(content).not.toContain('目录:')
    // 不选也要照旧是系统提示词开头,别让空串插出多余空行
    expect(content.startsWith(SYSTEM_PROMPT)).toBe(true)
  })

  it('空白串视为没选', () => {
    expect(systemPromptMessage('   ').content).not.toContain('## 本次会话的工作空间')
  })

  it('说明那句只讲事实,不含「请在工作空间内操作」这类祈使', () => {
    // 祈使会被模型当成本轮待办去执行(本项目在工具描述上踩过两次)
    const content = systemPromptMessage('/ws').content as string
    expect(content).not.toMatch(/请(?:只在|务必|优先)在/)
  })

  it('排在 skill 与角色目录之前:一个 run 的目录固定,而目录可能中途启停', () => {
    addSkill(skillNames[0], '规划路线')
    const content = systemPromptMessage('/ws').content as string
    expect(content.indexOf('本次会话的工作空间')).toBeLessThan(content.indexOf('## 可用 Skills'))
  })

  it('buildHistory 把它带进第一条 system:发给模型的历史与送去摘要的是同一份开头', () => {
    const history = buildHistory([], [], '', '/ws')
    expect(history[0].content).toContain('/ws')
  })
})

/**
 * 那一句有三种样子(什么都没开 / 只开写侧 jail / 还开了受限执行),而每一种都得是真话。
 * 这里断的是**分支之间必须不同**:接线把 `execConfined` 传漏了就只会少说一句(与 `confined`
 * 缺省 false 同一条保守方向),但把「不受限制」说成「受限制」同样要把 EPERM 归错地方 ——
 * 两种错都只在这三个分支互相比对时才显形。
 */
describe('工作空间那一句按边界装有几种说法', () => {
  it('什么都没开:两条边界都不提,越界只标注', () => {
    const note = workspaceNote('/ws')
    expect(note).toContain('不受它约束')
    expect(note).not.toContain('被拒绝')
    expect(note).not.toContain('受限执行')
  })

  it('只开写侧 jail 时 run_command 仍然写「不受这条限制」:这一句到今天还是真的', () => {
    const note = workspaceNote('/ws', true)
    expect(note).toContain('write_file 落在该目录之外时会被拒绝')
    expect(note).toContain('run_command 不受这条限制')
    expect(note).not.toContain('受限执行')
  })

  it('受限执行装着时那一句必须改口:谎报「不受限制」等于把边界交给模型的直觉', () => {
    const note = workspaceNote('/ws', true, true)
    expect(note).not.toContain('run_command 不受这条限制')
    expect(note).toContain('受限执行环境')
    expect(note).toContain('命令的文件写入出不了该目录与临时目录')
    // 读侧这一期没收:跟着一起改口就是另一种谎,所以那句的主语必须是 read_file
    expect(note).toContain('read_file 不受这条限制')
    expect(note).toContain('凭据目录它读不到')
  })

  it('systemPromptMessage 把第三个参数一路带到那一句:service.ts 只在这一层能被验到', () => {
    expect(systemPromptMessage('/ws', true, true).content).toContain('受限执行环境')
    expect(systemPromptMessage('/ws', true).content).not.toContain('受限执行环境')
  })

  it('三种说法都不含祈使:模型会把「请换个写法」当成本轮待办去执行', () => {
    for (const note of [
      workspaceNote('/ws'),
      workspaceNote('/ws', true),
      workspaceNote('/ws', true, true)
    ]) {
      expect(note).not.toMatch(/请|务必|必须|应该|不要|改用|换用/)
    }
  })
})

describe('system prompt 里的审批说明', () => {
  it('写明「被拒绝即操作没有进行」:否则模型会把那条拒绝当工具故障重试', () => {
    // 拒绝的结论由 chat/approval.ts 写成陈述句,提示词里引的是同一句原话
    expect(SYSTEM_PROMPT).toContain('用户拒绝了这次操作,操作没有进行')
    expect(SUB_AGENT_SYSTEM_PROMPT).toContain('用户拒绝了这次操作,操作没有进行')
  })

  it('那句不随档位变化:写成三种样子会在用户切档时再打掉一次 system 前缀', () => {
    // 模型需要知道的只有「拒绝是事实」,与当前是哪一档无关
    expect(SYSTEM_PROMPT).not.toMatch(/询问审批|自动审批|完全访问/)
  })
})

/**
 * 钩子那句话单独取出来断言:整份 prompt 里到处是「请」「不要」(那是别的规则),
 * 而祈使回归守卫要钉的只有这一句。
 */
function hookSentence(prompt: string): string {
  return prompt
    .split('\n')
    .filter((line) => line.includes('钩子'))
    .join('\n')
}

describe('system prompt 里的钩子说明', () => {
  it('主 / 子两份都有,且写明「被拦下是用户机器上的配置」:否则模型会把那次否决当工具故障重试', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(hookSentence(prompt)).toContain('用户自己安装的钩子程序')
      expect(hookSentence(prompt)).toContain('不是这次操作本身出了错')
    }
  })

  it('那句不含祈使:模型会把「请改用别的方式」当成本轮待办去执行', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(hookSentence(prompt)).not.toMatch(/请|务必|必须|应该|记得/)
    }
  })

  it('不随钩子数量、名称、sandboxed 变化:一句档位无关的常量才能保住 system 前缀', () => {
    // 与审批那句同一条纪律 —— 分成两种措辞会让用户每装或每删一条钩子就打掉一次前缀。
    // `HOOK.md` 不在禁用清单里:它是项目层那份固定布局的一部分,不随用户装了几条钩子变化
    expect(SYSTEM_PROMPT).not.toMatch(/sandboxed|matcher|某条具体的钩子名/)
  })

  it('不提「消息可能被改写」:改写对模型是透明的,写明只会让它怀疑自己的上下文', () => {
    expect(SYSTEM_PROMPT).not.toContain('改写')
    expect(SUB_AGENT_SYSTEM_PROMPT).not.toContain('改写')
  })
})

/** 讲自己运行机制那一段的标题:它必须留在 SYSTEM_PROMPT 常量里,而不是 workspaceNote */
const SELF_SECTION_TITLE = '## 关于你自己的运行环境'

/**
 * 「关于你自己的运行环境」那一段单独取出来断言,理由与 hookSentence 同一条:
 * 这一段只讲机制、一句祈使都不该有,而基础那十条规则里到处是「不要」(那是给模型的规矩),
 * 整份 prompt 一起跑守卫只会一路误报。
 */
function selfSection(prompt: string): string {
  expect(prompt).toContain(SELF_SECTION_TITLE)
  return prompt.slice(prompt.indexOf(SELF_SECTION_TITLE))
}

describe('system prompt 里讲自己运行机制那一段', () => {
  it('全局那份写明入口在用户那一侧:否则模型会去翻甚至去写那几处目录', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      const section = selfSection(prompt)
      expect(section).toContain('由用户在本机配置')
      expect(section).toContain('对所有会话生效')
      // 「全局不可改」不等于「项目层不可改」:下一句紧跟着讲的就是可以经文件工具改的那一层
      expect(section).toContain('没有给你修改这些配置的工具')
      expect(section).toContain('.cybertiger')
    }
  })

  it('全局与项目两层分开讲:混成一句「配置不可改」会与「文件工具能写 .cybertiger」自相矛盾', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      const section = selfSection(prompt)
      expect(section).toContain('全局')
      expect(section).toContain('项目级')
    }
    const main = selfSection(SYSTEM_PROMPT)
    // 写出「谁可写」比只写「哪一层在哪」更关键:模型据此决定去写文件还是回报做不成
    expect(main).toMatch(/read_file 与 write_file[^。]*读写它们/)
    expect(main).toContain('下一次 run')
  })

  it('三类目录只给名字不给绝对路径:那几处是这套护栏自身,写出路径就是递一张靶子', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      const section = selfSection(prompt)
      expect(section).toContain('skills / agents / hooks')
      expect(section).not.toMatch(/Library\/Application|AppData|\/Users\/|C:\\Users/)
    }
  })

  it('写明项目级那一层:目录名、四类配置、同名覆盖与生效时机', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      const section = selfSection(prompt)
      expect(section).toContain('.cybertiger')
      expect(section).toContain('同名条目覆盖全局那一份')
    }
    const main = selfSection(SYSTEM_PROMPT)
    expect(main).toContain('SKILL.md')
    expect(main).toContain('AGENT.md')
    expect(main).toContain('HOOK.md')
    expect(main).toContain('mcp.json')
    expect(main).toContain('自动建出来')
    expect(main).toContain('普通文件')
    expect(main).toContain('下一次 run')
  })

  it('主 Agent 知道项目配置可以经 write_file 改,子 Agent 也知道自己那份白名单里可能没有它', () => {
    // 这一句是「通过用户对话改自己的 skill / mcp」那条需求的落点:没有它模型会
    // 把「改配置」归到应用设置页那一侧,而不是去写工作空间里的文件
    expect(selfSection(SYSTEM_PROMPT)).toContain('write_file')
    expect(selfSection(SUB_AGENT_SYSTEM_PROMPT)).toContain('write_file')
    expect(selfSection(SUB_AGENT_SYSTEM_PROMPT)).toContain('工具白名单')
  })

  it('预算、去重、中止都归因成机制而不是故障:摘要块与「第二次拿到旧结果」不能读成自己丢了什么', () => {
    const main = selfSection(SYSTEM_PROMPT)
    expect(main).toContain('一段摘要替代')
    // 「已复用」是界面上的说法,模型的上下文里没有这两个字,所以提示词讲的是「拿回第一次那份结果」
    expect(main).toContain('只真正执行一次')
    // 去重只在只读工具上:副作用工具每次都真正执行,且执行后旧快照作废
    expect(main).toContain('每次都真正执行')
    expect(main).not.toContain('已复用')
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(selfSection(prompt)).toContain('机制在运行')
      expect(selfSection(prompt)).toContain('中止')
    }
  })

  it('这一段不含祈使:模型会把「请别动配置」当成本轮待办,与时间工具踩过的那一条同源', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(selfSection(prompt)).not.toMatch(/请|务必|必须|应该|记得|不要|改用|换用/)
    }
  })

  it('这一段是常量:档位名、引擎、装了哪几条钩子都不提,否则用户每动一个设置就重打一次前缀', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(selfSection(prompt)).not.toMatch(
        /询问审批|自动审批|完全访问|受限执行|sandbox-exec|bwrap|sandboxed|matcher/
      )
    }
  })

  it('进 SYSTEM_PROMPT 而不是 workspaceNote:后者换目录就要重打前缀,而这一段与目录无关', () => {
    expect(workspaceNote('/ws', true, true)).not.toContain(SELF_SECTION_TITLE)
    expect(systemPromptMessage('/ws').content).toContain(SELF_SECTION_TITLE)
  })
})

/**
 * 说明书里那几个数字必须与代码常量同源:改了上限却忘了改提示词,模型就会按旧数字
 * 规划下一步(「还有 10 步」而实际只剩 6 步),而那是从行为上最难反推的一类漂移。
 * 与 `LIST_ENTRY_SHAPES` 那两份同值复制同一条纪律:两处各写一份,由测试钉住相等。
 */
describe('自己那份说明书里的数字与代码常量同源', () => {
  it('步数上限、子 Agent 结论上限、后台作业上限逐条对上', () => {
    expect(selfSection(SYSTEM_PROMPT)).toContain(`${MAIN_AGENT_MAX_STEPS} 步`)
    // 步数上限之后还有一次不带工具的收尾:只写「10 步」会让模型以为到顶就没有下一次调用
    expect(selfSection(SYSTEM_PROMPT)).toContain('到顶之后还有一次收尾')
    expect(selfSection(SYSTEM_PROMPT)).toContain('不带工具')
    expect(selfSection(SYSTEM_PROMPT)).toContain(`${SUB_AGENT_MAX_STEPS} 步`)
    expect(selfSection(SUB_AGENT_SYSTEM_PROMPT)).toContain(`${SUB_AGENT_MAX_STEPS} 步`)
    // 结论上限在常量里是字符数,提示词写成 KB:8192 字符 = 8 KB
    expect(SUB_AGENT_RESULT_MAX).toBe(8 * 1024)
    expect(selfSection(SYSTEM_PROMPT)).toContain('8 KB')
    expect(selfSection(SYSTEM_PROMPT)).toContain(`${MAX_JOBS_PER_CONVERSATION} 个`)
    expect(selfSection(SYSTEM_PROMPT)).toContain(`${MAX_JOBS_TOTAL} 个`)
  })

  it('说明书列出的内置工具与注册表一致:名字对不上时模型会去调一个不存在的工具', async () => {
    const { builtinTools } = await import('../../../src/main/tools/registry')
    const section = selfSection(SYSTEM_PROMPT)
    // 前六个在 builtinTools 里;后三个按 run 现构造,不在那份注册表里
    const expected = [
      'get_current_time',
      'load_skill',
      'read_skill_file',
      'read_file',
      'write_file',
      'run_command',
      'ask_user',
      'background_job',
      'task'
    ]
    for (const name of expected) expect(section).toContain(name)
    // 注册表新增一个工具却没改这里时,这一条跟着红 —— 清单与真实能力是同一个集合
    for (const tool of builtinTools) expect(expected).toContain(tool.name)
  })
})

/**
 * 「这次用的是哪家服务商的哪个模型」那一句。
 * 它存在的理由不是给模型添料:用户问「你在用什么模型」时,模型答的是训练时那一个
 * (本地 qwen 说自己是 ChatGPT 是常态),而本机唯一记录了这次真发了哪个名字的地方在这里。
 */
describe('system prompt 里的本次模型说明', () => {
  const conn = {
    providerName: '本地 Ollama',
    model: 'qwen3.5:4b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'sk-local-secret',
    contextWindow: 32768
  }

  it('服务商与模型两个名字都写出来,用户问起时这一句就是答案', () => {
    const note = modelNote(conn)
    expect(note).toContain('## 本次执行使用的模型')
    expect(note).toContain('服务商:本地 Ollama')
    expect(note).toContain('模型:qwen3.5:4b')
    // 光给名字不够:小模型对自己的来历记忆是训练时那一个,不点破它会继续报那个
    expect(note).toContain('不是同一件事')
  })

  it('只写那两个名字,不带上 baseUrl 与 apiKey:这一句每步随 system 发给模型', () => {
    // resolveConnection 的整份连接里还有凭据;抄多了就是把密钥写进对话
    expect(modelNote(conn)).not.toContain('http://127.0.0.1:11434')
    expect(modelNote(conn)).not.toContain('sk-local-secret')
  })

  it('缺连接、缺任一字段或全是空白时整段不出现:接线漏了只会少说一句,不会报一个没解析出来的名字', () => {
    expect(modelNote(undefined)).toBe('')
    expect(modelNote({ providerName: '', model: 'qwen' })).toBe('')
    expect(modelNote({ providerName: 'Ollama', model: '   ' })).toBe('')
    expect(systemPromptMessage('/ws').content).not.toContain('## 本次执行使用的模型')
  })

  it('这一段是每次 run 现算的,不进两段常量:写进常量等于每次报同一个假名字', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain('## 本次执行使用的模型')
      expect(prompt).not.toContain('服务商:')
    }
  })

  it('排在边界那一句之后、两份目录之前:前缀按挥发性排,换模型不该重打工作空间那一节', () => {
    addSkill(skillNames[0], '规划路线')
    const content = systemPromptMessage('/ws', false, false, conn).content as string
    expect(content.indexOf('## 本次会话的工作空间')).toBeLessThan(
      content.indexOf('## 本次执行使用的模型')
    )
    expect(content.indexOf('## 本次执行使用的模型')).toBeLessThan(content.indexOf('## 可用 Skills'))
  })

  it('buildHistory 那条路不带它:尺寸估算手里没有连接,与 confined 同一条保守方向', () => {
    expect(buildHistory([], [], '', '/ws')[0].content).not.toContain('## 本次执行使用的模型')
  })

  it('那句不含祈使:模型会把「请以此为准」当成本轮待办,与时间工具踩过的那一条同源', () => {
    expect(modelNote(conn)).not.toMatch(/请|务必|必须|应该|记得|不要|改用|换用/)
  })
})

describe('system prompt 里的凭据与私密文件禁令', () => {
  it('主 / 子 Agent 两份都写明,且清单具体到路径:泛指「私密文件」小模型判不出边界', () => {
    for (const prompt of [SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(prompt).toContain('凭据与私密文件')
      expect(prompt).toContain('~/.ssh')
      expect(prompt).toContain('.env')
    }
  })

  it('写明「也不改用 shell 命令绕开」:只禁 read_file 的话,cat ~/.ssh/id_rsa 仍从另一条路走出去', () => {
    // 这正是本期 jail 管不到的那一侧 —— 读侧与 shell 都还没被结构性收住
    expect(SYSTEM_PROMPT).toMatch(/shell 命令\(cat、grep/)
    expect(SUB_AGENT_SYSTEM_PROMPT).toMatch(/shell 命令\(cat、grep/)
  })

  it('子 Agent 那份要把缺口写回结论:它面前没有用户,静默跳过会让主 Agent 以为做成了', () => {
    expect(SUB_AGENT_SYSTEM_PROMPT).toMatch(/写进结论/)
  })

  it('主 Agent 那份留一条「用户明确点名某个文件时照做」:否则「看下我的 ~/.zshrc」这类请求会被凭空拒掉', () => {
    expect(SYSTEM_PROMPT).toContain('明确点名')
  })

  it('三个文件 / shell 工具的描述里也各带一句:工具描述每步整份下发、比 system 更靠近,两处口径必须一致', () => {
    // 见 AGENTS.md「给模型看的文案」那条 —— 冲突时更具体的那份赢,只写 system 等于没写
    expect(readFileTool.description).toContain('凭据与私密文件')
    expect(writeFileTool.description).toContain('凭据与私密文件')
    expect(runCommandTool.description).toContain('凭据与私密文件')
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
