import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Result, Tooltip, theme as antdTheme } from 'antd'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalEvent, TerminalSessionInfo } from '../../../../main/terminal/dto'
import { useSystemTheme } from '../../hooks/useSystemTheme'
import { xtermTheme } from '../../lib/xtermTheme'
import { FONT_MONO } from '../../theme'

interface TerminalViewProps {
  conversationId: string | null
  workspace: string
}

type Status = 'connecting' | 'ready' | 'exited' | 'error'

function fallbackNote(source: TerminalSessionInfo['cwdSource']): string {
  if (source === 'default-workspace') return '当前会话未选择工作空间，终端在默认工作空间启动'
  if (source === 'home') return '没有可用工作空间，终端在主目录启动'
  return ''
}

/**
 * 终端视图。
 *
 * 会话由主进程按工作目录复用,所以这里只负责「把屏幕接上去」:先订阅事件再 ensure,
 * ensure 回来的 backlog 写完、再把快照之后的事件补上 —— 顺序反了,Cmd+R 之后就会丢一截
 * 或把同一段输出写两遍。关面板只 dispose xterm,不通知主进程杀 shell。
 */
function TerminalView({ conversationId, workspace }: TerminalViewProps): React.JSX.Element {
  const { token } = antdTheme.useToken()
  const isDark = useSystemTheme()

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /** 当前屏幕对应的主进程会话;写键盘输入与 resize 都要带它 */
  const terminalIdRef = useRef<string | null>(null)
  /** 上一次 ensure 的 id:换目录才 reset,同一目录重开面板不能把屏幕清掉 */
  const previousIdRef = useRef<string | null>(null)

  const [session, setSession] = useState<TerminalSessionInfo | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  /** 出错或进程退出后手动重来一次;变化即重新 ensure(主进程会新建 shell) */
  const [epoch, setEpoch] = useState(0)

  // 终端实例只建一次;主题另走一条 effect,换色时只改 options,不重建实例
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: FONT_MONO,
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      theme: xtermTheme(token, isDark)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const safeFit = (): void => {
      try {
        fit.fit()
      } catch {
        // 面板还没量出尺寸(fit 会除零):下一次 resize 观察再试
      }
    }
    safeFit()

    // 键盘输入直接交给 shell;id 现读,避免拿住上一次会话
    const dataDisposable = term.onData((data) => {
      const terminalId = terminalIdRef.current
      if (!terminalId) return
      void window.api.terminal.write({ terminalId, data })
    })

    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      // 连续回调合并到一帧:拖动窗口时 fit 与 IPC 都不该每次像素变化都跑一遍
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        safeFit()
        const terminalId = terminalIdRef.current
        if (!terminalId) return
        void window.api.terminal.resize({ terminalId, cols: term.cols, rows: term.rows })
      })
    })
    observer.observe(host)
    term.focus()

    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
      dataDisposable.dispose()
      // 只放开屏幕,不杀 shell:关面板不等于结束正在跑的构建
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 只在挂载时建一次:token / isDark 走下面那条 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermTheme(token, isDark)
  }, [token, isDark])

  useEffect(() => {
    const term = termRef.current
    if (!term) return

    let cancelled = false
    let buffering = true
    let terminalId: string | null = null
    let snapshotSeq = 0
    const buffered: TerminalEvent[] = []

    setStatus('connecting')
    setErrorMsg('')
    setExitCode(null)

    const apply = (event: TerminalEvent): void => {
      if (!terminalId || event.terminalId !== terminalId) return
      if (event.type === 'data') {
        term.write(event.data)
        return
      }
      term.write(`\r\n[进程已退出，退出码 ${event.code}]\r\n`)
      setExitCode(event.code)
      setStatus('exited')
    }

    // 先订阅再 ensure:ensure 期间到达的输出先压进本地数组,等 backlog 写完再补
    const unsubscribe = window.api.terminal.onEvent((event) => {
      if (buffering) buffered.push(event)
      else apply(event)
    })

    void (async () => {
      const res = await window.api.terminal.ensure({
        conversationId,
        cols: term.cols,
        rows: term.rows
      })
      if (cancelled) return
      if (!res.success) {
        setStatus('error')
        setErrorMsg(res.msg)
        return
      }

      const info = res.data
      terminalId = info.terminalId
      terminalIdRef.current = info.terminalId
      if (previousIdRef.current !== info.terminalId) term.reset()
      previousIdRef.current = info.terminalId
      if (info.backlog) term.write(info.backlog)
      snapshotSeq = info.seq
      setSession(info)
      setStatus('ready')

      buffering = false
      for (const event of buffered) {
        if (event.terminalId !== info.terminalId) continue
        if (event.type === 'data') {
          if (event.seq > snapshotSeq) term.write(event.data)
        } else {
          apply(event)
        }
      }
      buffered.length = 0

      term.focus()
      // 打开面板时容器可能刚量出尺寸,补一次 fit 让 cols/rows 与真窗口一致
      try {
        fitRef.current?.fit()
        void window.api.terminal.resize({
          terminalId: info.terminalId,
          cols: term.cols,
          rows: term.rows
        })
      } catch {
        // 同上:尺寸还没量出来就等 ResizeObserver
      }
    })()

    return () => {
      cancelled = true
      unsubscribe()
      terminalIdRef.current = null
    }
  }, [conversationId, workspace, epoch])

  const retry = useCallback((): void => {
    setEpoch((value) => value + 1)
  }, [])

  const note = session ? fallbackNote(session.cwdSource) : ''

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {session && note && (
        <div
          style={{
            flex: 'none',
            height: 28,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: `0 ${token.paddingSM}px`,
            fontSize: 12,
            color: token.colorTextSecondary,
            borderBottom: `1px solid ${token.colorBorderSecondary}`
          }}
        >
          <span style={{ flex: 'none' }}>{note}</span>
          <Tooltip title={session.cwd}>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: FONT_MONO
              }}
            >
              {session.cwd}
            </span>
          </Tooltip>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        {status === 'error' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: token.colorBgContainer,
              overflow: 'auto'
            }}
          >
            <Result
              status="warning"
              title="终端启动失败"
              subTitle={errorMsg}
              extra={
                <Button type="primary" onClick={retry}>
                  重试
                </Button>
              }
            />
          </div>
        )}
      </div>

      {status === 'exited' && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: token.marginSM,
            padding: `${token.paddingXS}px ${token.paddingSM}px`,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            fontSize: 12,
            color: token.colorTextSecondary
          }}
        >
          <span>终端进程已结束{exitCode === null ? '' : `，退出码 ${exitCode}`}</span>
          <Button size="small" onClick={retry}>
            重新启动
          </Button>
        </div>
      )}
    </div>
  )
}

export default TerminalView
