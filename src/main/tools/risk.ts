/**
 * shell 命令的风险判定。
 *
 * **方向是「白名单式证明安全」,不是「黑名单式挑危险」** —— 后者在这里根本不成立:
 * `bash -c "…"`、`python -c`、`$(...)`、`xargs`、`curl | sh`、`git push --force`、
 * `cat f > /etc/hosts` 都能把危险内容藏在参数里,任何「危险命令清单」都拦不住。
 * 所以这里只回答一个问题:这条命令能不能被**证明**成「只读、不改本机状态」?
 * 证明不了就是一等公民(要审批)。误报的代价是多问一次,漏报的代价是用户机器被改。
 */

export type RiskLevel = 'low' | 'elevated'

export interface CommandRisk {
  level: RiskLevel
  /** 面向用户的中文:审批卡片要逐条列出「为什么这条要多问一次」 */
  reasons: string[]
}

/** 判定的规模上限:超了就说明这条命令不是「随手一句 ls」,不再试图理解它 */
const MAX_COMMAND_CHARS = 2000
const MAX_SEGMENTS = 8
const MAX_ARGV = 16

/**
 * 引号外一出现就无法证明安全的构造。
 * `&&` `||` `|` `;` 换行是分段符,在词法里先被消费掉,所以 `&` 落到这里表示「后台执行」。
 * `!` 算危险是因为 bash 的历史扩展能把它变成另一条命令;`$` 与反引号是命令与变量替换,
 * 替换出来的内容我们看不见,因此不能放行。
 */
const UNSAFE_OUTSIDE_QUOTE = new Set([
  '$',
  '`',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '*',
  '?',
  '[',
  '\\',
  '!',
  '&'
])

interface SafeSpec {
  /**
   * 允许的子命令(第一个位置参数)。省略表示位置参数随便填。
   * 写了它就意味着「必须有子命令」,所以 `git` 光秃秃一条不算低风险。
   */
  subcommands?: string[]
  /** 整条 argv(含 argv[0])必须正好等于其中之一:给 `node --version` 这种用 */
  exact?: string[]
  /** 这些选项(或其前缀)一出现就升高风险 */
  bannedOptions?: string[]
  /** 位置参数个数上限,比如 diff 只接受两个输入 */
  maxPositional?: number
}

/**
 * 已证明只读的命令清单。
 * 入选标准:**不改本机任何状态,且不执行调用方给的代码**。
 * 所以 `sed`(能改文件、GNU 版还能 `e` 执行命令)、`awk`(有 `system()`)、
 * `npm run` / `npx` / `make` / `python` / `node` 这些「参数就是代码」的都不在列 ——
 * 包括我们自己工具描述里推荐的 `sed -n`:它确实能改文件,该问就问。
 */
const SAFE_READ_ONLY: Record<string, SafeSpec> = {
  ls: {},
  pwd: { exact: ['pwd'] },
  cat: {},
  head: {},
  tail: {},
  grep: {},
  rg: {},
  fgrep: {},
  egrep: {},
  wc: {},
  sort: { bannedOptions: ['-o'] },
  uniq: {},
  cut: {},
  tr: {},
  diff: { maxPositional: 2 },
  cmp: { maxPositional: 2 },
  comm: { maxPositional: 2 },
  find: {
    bannedOptions: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']
  },
  stat: {},
  file: {},
  basename: {},
  dirname: {},
  realpath: {},
  readlink: {},
  which: {},
  whereis: {},
  whoami: { exact: ['whoami'] },
  id: { exact: ['id'] },
  uname: {},
  hostname: {},
  date: {},
  df: {},
  du: {},
  seq: {},
  echo: {},
  ps: {},
  base64: { bannedOptions: ['-o'] },
  md5: {},
  md5sum: {},
  shasum: {},
  sha256sum: {},
  git: {
    subcommands: [
      'status',
      'log',
      'diff',
      'show',
      'blame',
      'branch',
      'rev-parse',
      'describe',
      'ls-files',
      'remote'
    ],
    // `-c` 能注入配置(含会执行命令的 core.fsmonitor / alias),`-p` 之外的 -P 无害;
    // branch 的删除与改名靠下面的 bannedOptions 挡
    bannedOptions: ['-c', '--config-env', '-D', '-d', '-M', '-m', '-P'],
    maxPositional: 4
  },
  node: { exact: ['node --version', 'node -v', 'node --help', 'node -h'] },
  npm: { subcommands: ['ls', 'outdated', 'view'], maxPositional: 3 },
  pip: { subcommands: ['list', 'show', 'freeze'], maxPositional: 3 },
  docker: { subcommands: ['ps', 'images', 'inspect', 'logs', 'version'], maxPositional: 3 }
}

/** argv 里的选项写法:`-x` 与 `--xxx=值` 都只取到 `=` 之前参与比对 */
function optionName(token: string): string {
  const head = token.split('=')[0]
  return head
}

function isOption(token: string): boolean {
  // 单独的 `-` 是 stdin 的惯用写法,不是选项
  return token.length > 1 && token.startsWith('-')
}

type Lexed = { ok: true; segments: string[][] } | { ok: false; reason: string }

/**
 * 把命令切成「分段 × argv」。
 *
 * 只做一件事:在引号外识别分段符,并把 token 切出来。任何我们看不懂的东西(引号没闭合、
 * 引号外出现替换或重定向)都直接返回 not-ok —— 调用方据此升高风险,不猜。
 * 单引号里的内容一律是字面量,所以 `$` 在里面不算替换;双引号里 `$` 仍然会展开。
 */
function lex(command: string): Lexed {
  const segments: string[][] = []
  let argv: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null

  const pushToken = (): void => {
    if (token) {
      argv.push(token)
      token = ''
    }
  }
  const pushSegment = (): void => {
    pushToken()
    segments.push(argv)
    argv = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      // 双引号里的 `$` 与反引号照样会展开成我们看不见的东西
      if (quote === '"' && (ch === '$' || ch === '`')) {
        return { ok: false, reason: '命令里有变量或命令替换,替换结果无法预先判断' }
      }
      token += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (ch === '\n') {
        pushSegment()
      } else {
        pushToken()
      }
      continue
    }
    if (ch === '|') {
      pushSegment()
      // `||` 也算分段:两段各自判风险,合起来不更危险
      if (command[i + 1] === '|') i += 1
      continue
    }
    if (ch === ';') {
      pushSegment()
      continue
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        pushSegment()
        i += 1
        continue
      }
      return { ok: false, reason: '命令里有后台执行(&)' }
    }
    if (UNSAFE_OUTSIDE_QUOTE.has(ch)) {
      return { ok: false, reason: '命令里有重定向、替换或通配等无法预判的写法' }
    }
    token += ch
  }

  if (quote) return { ok: false, reason: '命令里的引号没有闭合' }
  pushSegment()
  // 末尾的分段符会留一个空段;`ls ;;` 这种写法我们不看第二遍
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: '命令里有空的分段' }
  }
  return { ok: true, segments }
}

/**
 * 参数指向工作空间之外:清单里的命令都是只读的,但**读哪儿**是另一回事。
 * `cat ~/.ssh/id_rsa` 与 `read_file ~/.ssh/id_rsa` 必须走同一道审批,否则换个入口就绕开了闸门。
 */
function hasOutsidePath(positionals: string[]): boolean {
  return positionals.some((item) => item.startsWith('/') || item.startsWith('~'))
}

function classifySegment(argv: string[]): string[] {
  if (argv.length === 0) return ['有一个空的分段']
  if (argv.length > MAX_ARGV) return [`有一段命令的参数超过 ${MAX_ARGV} 个,不再试图理解它`]
  const name = argv[0]
  // `/bin/ls` 与 `./evil` 都长得像清单里的名字,但指向什么我们不知道
  if (name.includes('/') || name.includes('\\')) {
    return [`用路径直接调用程序(${name}),不确定它是什么`]
  }
  const spec = SAFE_READ_ONLY[name]
  if (!spec) return [`${name} 不在只读命令清单里`]

  const reasons: string[] = []
  const tokens = argv.slice(1)

  if (spec.exact) {
    const written = [name, ...tokens].join(' ')
    if (!spec.exact.includes(written)) {
      reasons.push(`${name} 只在看版本或帮助时算低风险,这里带的是别的参数`)
    }
    return reasons
  }

  const options = tokens.filter(isOption)
  const positionals = tokens.filter((token) => !isOption(token))

  for (const option of options) {
    const key = optionName(option)
    // `-delete` 与 `-delete=1` 这类写法都要命中同一条禁令
    if (spec.bannedOptions?.some((banned) => key === banned || key.startsWith(`${banned}=`))) {
      reasons.push(`${name} 带了 ${key},它会改动本机状态`)
    }
  }

  if (spec.subcommands) {
    const sub = positionals[0]
    if (!sub) reasons.push(`${name} 缺子命令,判断不了它要做什么`)
    else if (!spec.subcommands.includes(sub)) {
      reasons.push(`${name} ${sub} 不在只读子命令清单里`)
    }
  }

  if (spec.maxPositional !== undefined && positionals.length > spec.maxPositional) {
    reasons.push(`${name} 的位置参数比预期多,判断不了实际读写的是什么`)
  }

  if (hasOutsidePath(name === 'find' ? positionals.slice(1) : positionals)) {
    reasons.push('参数指向工作空间之外的路径')
  }

  return reasons
}

/**
 * 判定一条命令的风险。
 *
 * 分段(| && ; 换行)**每段都得证明**,合起来才算低风险 —— 否则 `ls; rm -rf ~`
 * 会因为开头那段无害而整条放行,那是最省事的绕过方式。
 */
export function classifyCommand(command: string): CommandRisk {
  const trimmed = command.trim()
  if (!trimmed) return { level: 'elevated', reasons: ['命令是空的'] }
  if (trimmed.length > MAX_COMMAND_CHARS) {
    return {
      level: 'elevated',
      reasons: [`命令长 ${trimmed.length} 字符,超过 ${MAX_COMMAND_CHARS},不再试图理解它`]
    }
  }
  const lexed = lex(trimmed)
  if (!lexed.ok) return { level: 'elevated', reasons: [lexed.reason] }
  if (lexed.segments.length > MAX_SEGMENTS) {
    return {
      level: 'elevated',
      reasons: [`命令有 ${lexed.segments.length} 段,超过 ${MAX_SEGMENTS} 段`]
    }
  }

  const reasons: string[] = []
  for (const argv of lexed.segments) {
    for (const reason of classifySegment(argv)) {
      if (!reasons.includes(reason)) reasons.push(reason)
    }
  }
  return { level: reasons.length === 0 ? 'low' : 'elevated', reasons }
}

/**
 * 给审批名单用的分段结果:看不懂(引号未闭合、有危险构造)时返回 null。
 *
 * 名单里的命令前缀要按 token 边界比对,而 token 只能从同一份词法里来 —— 另写一个切分器
 * 就会出现「名单按 A 判、风险按 B 判」,同一个 `git status` 一处认一处不认。
 */
export function commandSegments(command: string): string[][] | null {
  const lexed = lex(command.trim())
  return lexed.ok ? lexed.segments : null
}

/**
 * 「本轮同类都允许」的键:命令名 + 后面最多两个非选项参数,逐段拼接。
 *
 * 取到 `git push` 这一级而不是 `git`,是因为按了那颗按钮就等于放行一整类,
 * 粒度越粗,用户按下去时越容易低估后果;键本身要显示在卡片上。
 */
export function commandAllowKey(command: string): string {
  const lexed = lex(command.trim())
  if (!lexed.ok) return command.trim().slice(0, 40)
  return lexed.segments
    .map((argv) => {
      const head = [argv[0]]
      for (const token of argv.slice(1)) {
        if (isOption(token)) continue
        head.push(token)
        if (head.length >= 3) break
      }
      return head.join(' ')
    })
    .join(' ; ')
}

/** 给界面用的只读清单,设置页与卡片文案都引它,不再另抄一份 */
export function safeCommandNames(): string[] {
  return Object.keys(SAFE_READ_ONLY).sort()
}
