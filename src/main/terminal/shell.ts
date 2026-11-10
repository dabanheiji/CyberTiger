import path from 'node:path'
import { augmentPath } from '../sandbox/env'

export interface ShellSpec {
  file: string
  args: string[]
  env: Record<string, string>
}

/** Electron 注入的变量留给孩子 shell 只会制造怪问题(如让基于 Electron 的工具按 node 跑) */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']

/**
 * 用户终端的 shell 与环境。
 *
 * 环境是**完整继承**而不是 `sandbox/env.ts` 的 `minimalEnv`:后者是白名单,
 * 会拿掉用户的凭据与工具变量,正好把「自己的终端」变成不能用。只补三处:
 * 抹掉 Electron 的注入、给出终端色彩所需的两项、按既有清单补 PATH。
 */
export function shellSpec(
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv,
  home: string
): ShellSpec {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || STRIPPED_ENV.includes(key)) continue
    env[key] = value
  }
  env.PATH = platform === 'win32' ? (source.PATH ?? '') : augmentPath(source.PATH ?? '', home)

  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'], env }
  }

  const shell =
    source.SHELL && path.isAbsolute(source.SHELL)
      ? source.SHELL
      : platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  return { file: shell, args: ['-l'], env }
}
