import { useEffect, useState } from 'react'
import { Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Typography } from 'antd'
import { HOOK_EVENTS } from '../../../../main/hooks/types'
import type { HookDraft, HookEvent, HookMeta } from '../../../../main/hooks/types'
import { HOOK_MATCHER_SHAPES, joinHookEntries, parseHookEntries } from '../../lib/hookMatchers'

/** 文本框里存的是多行字符串,提交时才切成数组(args 与 matcher 都一行一条) */
interface HookFormValues {
  name: string
  description: string
  event: HookEvent
  command: string
  argsText: string
  matcherText: string
  sandboxed: boolean
  timeout?: number
  once: boolean
  doc: string
}

interface HookFormDrawerProps {
  open: boolean
  /** null 表示新建,否则为正在编辑的那一条 */
  hook: HookMeta | null
  onClose: () => void
  /** 返回是否保存成功;成功时由本组件负责关闭 */
  onSubmit: (draft: HookDraft) => Promise<boolean>
}

/** 角色名规则与主进程 validateName 保持一致,避免前端放过、落盘才报错 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 六个时机各自的界面说法。
 *
 * 只写英文字段名用户读不出区别,而这份说明不影响任何判定(判定按 `HOOK_EVENTS` 那六个字面量),
 * 所以它留在渲染层;清单本身仍来自 `HOOK_EVENTS`,不另列一份以免漂开。
 */
const EVENT_HINTS: Record<HookEvent, string> = {
  beforeAgent: '一轮对话开始之前(每轮一次)',
  beforeRequest: '每一次发给模型之前(能读到、也可改写整份出站消息)',
  afterRequest: '模型那一步的回答到手之后',
  beforeToolCall: '每一次工具执行之前(可以拦下那次调用)',
  afterToolCall: '每一次工具执行之后',
  afterAgent: '一轮结束之时(收尾、中止、超步数、报错四种结束都触发)'
}

function HookFormDrawer({ open, hook, onClose, onSubmit }: HookFormDrawerProps): React.JSX.Element {
  const [form] = Form.useForm<HookFormValues>()
  const [saving, setSaving] = useState(false)

  // 每次打开都用当前这条钩子(或空表单)重置,避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    form.setFieldsValue({
      name: hook?.name ?? '',
      description: hook?.description ?? '',
      event: hook?.event ?? 'beforeAgent',
      command: hook?.command ?? '',
      argsText: joinHookEntries(hook?.args ?? []),
      matcherText: joinHookEntries(hook?.matcher ?? []),
      sandboxed: hook?.sandboxed ?? false,
      timeout: hook?.timeoutMs,
      once: hook?.once ?? false,
      doc: hook?.doc ?? ''
    })
  }, [open, hook, form])

  const handleOk = async (): Promise<void> => {
    let values: HookFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const draft: HookDraft = {
      name: values.name,
      description: values.description,
      event: values.event,
      command: values.command,
      args: parseHookEntries(values.argsText ?? ''),
      matcher: parseHookEntries(values.matcherText ?? ''),
      sandboxed: values.sandboxed,
      timeout: values.timeout,
      once: values.once,
      doc: values.doc ?? ''
    }

    setSaving(true)
    try {
      if (await onSubmit(draft)) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      title={hook ? `编辑钩子:${hook.name}` : '新建钩子'}
      width={560}
      onClose={onClose}
      destroyOnHidden
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleOk}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="name"
          label="钩子名"
          extra={
            hook
              ? '改名会同时重命名这条钩子的目录;目录名就是它的身份,日志与「最近执行」都按这个名字记账。'
              : '只能用小写字母、数字和连字符;它会成为 hooks 目录下的那个目录名。'
          }
          rules={[
            { required: true, message: '请填写钩子名' },
            { max: 64, message: '不能超过 64 个字符' },
            {
              pattern: NAME_PATTERN,
              message: '只能包含小写字母、数字和连字符,不能以连字符开头/结尾'
            }
          ]}
        >
          <Input placeholder="例如 block-force-push" />
        </Form.Item>

        <Form.Item
          name="description"
          label="描述"
          extra="界面上一行只放得下这句话,写清它在管哪一件事。"
          rules={[
            { required: true, message: '请填写描述' },
            { max: 1024, message: '不能超过 1024 个字符' }
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="拦下任何 git push --force,先让模型确认分支"
          />
        </Form.Item>

        <Form.Item
          name="event"
          label="触发时机"
          extra="一个文件只声明一个时机;六个里挑一个,其余五个都不会跑。"
          rules={[{ required: true, message: '请选择触发时机' }]}
        >
          <Select
            popupMatchSelectWidth={false}
            options={HOOK_EVENTS.map((event) => ({
              value: event,
              label: `${event} · ${EVENT_HINTS[event]}`
            }))}
          />
        </Form.Item>

        <Form.Item
          name="command"
          label="程序"
          extra={
            <div>
              <Typography.Text style={{ display: 'block' }}>
                相对路径按这条钩子自己的目录解析，程序也在那个目录里运行；只写命令名（如 node）则按
                PATH 查找。
              </Typography.Text>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                名字里带点（如 <code>hook.mjs</code>、<code>pip3.11</code>
                ）会被当成文件名而不是命令名；要跑 PATH 里那种带点的程序，写绝对路径。
              </Typography.Text>
            </div>
          }
          rules={[
            { required: true, message: '请填写要运行的程序' },
            { max: 1024, message: '不能超过 1024 个字符' }
          ]}
        >
          <Input placeholder="例如 ./check.mjs 或 /usr/bin/python3" />
        </Form.Item>

        <Form.Item
          name="argsText"
          label="参数"
          extra="一行一个,原样交给那个程序(带空格的参数不会再被切一次)。留空即不带参数。"
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder={'--strict\n--config ./rules.json'}
          />
        </Form.Item>

        <Form.Item
          name="matcherText"
          label="matcher(管哪一次工具调用)"
          extra={
            <div>
              <Typography.Text style={{ display: 'block' }}>
                只有「工具执行之前 / 之后」这两个时机读它;其余时机上给了会被忽略并在日志里记一行。
              </Typography.Text>
              {HOOK_MATCHER_SHAPES.map((shape) => (
                <Typography.Text
                  key={shape}
                  type="secondary"
                  style={{ display: 'block', fontSize: 12 }}
                >
                  · {shape}
                </Typography.Text>
              ))}
            </div>
          }
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder={'run_command:git push\nmcp_server__'}
          />
        </Form.Item>

        <Form.Item
          name="sandboxed"
          label="把这条钩子关进受限执行环境"
          valuePropName="checked"
          extra="打开后它与 run_command 走同一道边界(写不出工作空间、清单点名的凭据目录读不到)。前提要成立:本次会话选了工作空间、这台机器有对应机制;两者缺一个,这条钩子会被跳过并写明理由,应用不会退回「不受限地把它跑一遍」。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="timeout"
          label="超时(毫秒)"
          extra="留空即 10000 毫秒,上限 60000。超时那一次没有结论:钩子按「没拦住」收场,只留一行日志。"
        >
          <InputNumber min={1} max={60000} step={1000} style={{ width: 200 }} />
        </Form.Item>

        <Form.Item
          name="once"
          label="每轮只触发一次"
          valuePropName="checked"
          extra="只有「发给模型之前」那个时机读它。改写整段消息会让这个会话的提示缓存从头重算,所以那种钩子建议勾上这一颗。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="doc"
          label="说明正文"
          extra="写进这份 HOOK.md 正文、给人看的那一段。它不进 payload,也不发给模型。"
        >
          <Input.TextArea
            autoSize={{ minRows: 5, maxRows: 14 }}
            placeholder="这条钩子会读 git status 的输出……"
          />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

export default HookFormDrawer
