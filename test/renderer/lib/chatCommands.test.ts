import {
  CHAT_COMMANDS,
  COMMAND_VALUE_PREFIX,
  commandBlockedReason,
  matchesSlashQuery,
  readChatCommand,
  readSlashQuery
} from '../../../src/renderer/src/lib/chatCommands'

describe('readChatCommand:整条输入恰好是一个命令时才认', () => {
  it('命中 compact 与 plan', () => {
    expect(readChatCommand('/compact')?.name).toBe('compact')
    expect(readChatCommand('/plan')?.name).toBe('plan')
  })

  it('首尾空白与大小写都不影响识别:用户不会为了按命令而精确对齐', () => {
    expect(readChatCommand('  /compact  ')?.name).toBe('compact')
    expect(readChatCommand('/COMPACT')?.name).toBe('compact')
  })

  it('带参数就不是命令,交给模型当普通消息', () => {
    // 首期没有命令参数,猜用户想传什么不如原样发给他
    expect(readChatCommand('/compact foo')).toBeUndefined()
  })

  it('只有整条输入以斜杠开头才算:正文里的斜杠不是命令', () => {
    expect(readChatCommand('看下 /compact')).toBeUndefined()
  })

  it('空串、单个斜杠、未登记的名字、纯数字都不算', () => {
    expect(readChatCommand('')).toBeUndefined()
    expect(readChatCommand('/')).toBeUndefined()
    expect(readChatCommand('/未知')).toBeUndefined()
    expect(readChatCommand('/compact-x')).toBeUndefined()
    expect(readChatCommand('/2x')).toBeUndefined()
  })

  it('清单里每个名字都能被自己识别出来:改清单即改行为,不会出现只能看不能用的命令', () => {
    for (const command of CHAT_COMMANDS) {
      expect(readChatCommand(`/${command.name}`)).toBe(command)
    }
  })

  it('命名空间带冒号,skill 名(kebab-case)撞不上', () => {
    expect(COMMAND_VALUE_PREFIX).toContain(':')
  })
})

describe('readSlashQuery / matchesSlashQuery:菜单里只留命中项', () => {
  it('斜杠后面那一段就是过滤词', () => {
    expect(readSlashQuery('/com')).toBe('com')
    expect(readSlashQuery('/COMPACT')).toBe('COMPACT')
  })

  it('只敲一个斜杠时过滤词是空串:菜单照常列出全部条目', () => {
    expect(readSlashQuery('/')).toBe('')
    expect(matchesSlashQuery('compact', '')).toBe(true)
  })

  it('出现空白就不再是命令输入:带参数与正文里的斜杠都不该过滤菜单', () => {
    expect(readSlashQuery('/compact foo')).toBeUndefined()
    expect(readSlashQuery('/compact ')).toBeUndefined()
    expect(readSlashQuery('/compact\n')).toBeUndefined()
    expect(readSlashQuery('看下 /compact')).toBeUndefined()
    expect(readSlashQuery('')).toBeUndefined()
  })

  it('前缀匹配、忽略大小写:/com 命中 compact,/c 也能命中', () => {
    expect(matchesSlashQuery('compact', 'com')).toBe(true)
    expect(matchesSlashQuery('compact', 'COM')).toBe(true)
    expect(matchesSlashQuery('compact', 'c')).toBe(true)
  })

  it('命令之间不串:/pl 只命中 plan,/com 只命中 compact', () => {
    expect(matchesSlashQuery('plan', 'pl')).toBe(true)
    expect(matchesSlashQuery('compact', 'pl')).toBe(false)
    expect(matchesSlashQuery('plan', 'com')).toBe(false)
    // 空过滤词两者都命中(只敲一个斜杠时菜单要列全)
    expect(matchesSlashQuery('plan', '')).toBe(true)
  })

  it('只认前缀而不是任意位置:名字中段出现不算命中', () => {
    // 前缀比「包含」更可预测 —— 敲一个字母时不会把大半个清单都摆出来
    expect(matchesSlashQuery('compact', 'pact')).toBe(false)
    expect(matchesSlashQuery('compact', 'comx')).toBe(false)
  })
})

describe('commandBlockedReason:菜单与执行共用的单一门禁源', () => {
  const ready = { hasConversation: true, hasModel: true, sending: false, compacting: false }

  it('都满足时两条命令都不拦', () => {
    expect(commandBlockedReason('compact', ready)).toBeUndefined()
    expect(commandBlockedReason('plan', ready)).toBeUndefined()
  })

  describe('compact 原有四条门禁不回归', () => {
    it('没有对话', () => {
      expect(commandBlockedReason('compact', { ...ready, hasConversation: false })).toContain(
        '还没有内容'
      )
    })

    it('这一轮还在跑', () => {
      expect(commandBlockedReason('compact', { ...ready, sending: true })).toContain('还在进行中')
    })

    it('上一次压缩还没结束', () => {
      expect(commandBlockedReason('compact', { ...ready, compacting: true })).toContain('正在压缩')
    })

    it('没有可用模型', () => {
      expect(commandBlockedReason('compact', { ...ready, hasModel: false })).toContain(
        '配置模型服务商'
      )
    })

    it('同时命中多条时先说最靠前的那条:用户不需要一次看完所有前提', () => {
      const all = { hasConversation: false, hasModel: false, sending: true, compacting: true }
      expect(commandBlockedReason('compact', all)).toContain('还没有内容')
      expect(commandBlockedReason('compact', { ...all, hasConversation: true })).toContain(
        '还在进行中'
      )
      expect(
        commandBlockedReason('compact', {
          hasConversation: true,
          hasModel: false,
          sending: false,
          compacting: true
        })
      ).toContain('正在压缩')
    })
  })

  describe('plan 只挡「进行中」与「没选模型」', () => {
    it('草稿态允许:计划模式正是从新会话的第一句需求开始的', () => {
      expect(commandBlockedReason('plan', { ...ready, hasConversation: false })).toBeUndefined()
    })

    it('没有待压的内容不妨碍进入计划模式(compacting 与它无关)', () => {
      expect(
        commandBlockedReason('plan', {
          hasConversation: false,
          hasModel: true,
          sending: false,
          compacting: true
        })
      ).toBeUndefined()
    })

    it('这一轮还在跑时不许切:新旧两条 run 会争同一个会话', () => {
      expect(commandBlockedReason('plan', { ...ready, sending: true })).toContain('还在进行中')
    })

    it('没有可用模型', () => {
      expect(commandBlockedReason('plan', { ...ready, hasModel: false })).toContain(
        '配置模型服务商'
      )
    })

    it('两条同时命中时先说进行中', () => {
      expect(commandBlockedReason('plan', { ...ready, sending: true, hasModel: false })).toContain(
        '还在进行中'
      )
    })
  })

  it('未登记的名字不拦(菜单里本就不会出现它)', () => {
    expect(commandBlockedReason('unknown', { ...ready, sending: true })).toBeUndefined()
  })
})
