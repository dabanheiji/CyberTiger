import { useState } from 'react'
import {
  Alert,
  App,
  Button,
  Checkbox,
  Flex,
  Input,
  List,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
  theme
} from 'antd'
import { CloudDownloadOutlined, FolderOpenOutlined, ImportOutlined } from '@ant-design/icons'
import type { DiscoverResult, SkillMeta, SkillSource } from '../../../../main/skills/types'
import { useSkills } from '../../hooks/useSkills'

function sourceTag(source: SkillSource): React.ReactNode {
  if (source.type === 'github') {
    return (
      <Tag color="blue">
        GitHub {source.repo}
        {source.subpath ? `/${source.subpath}` : ''}
      </Tag>
    )
  }
  if (source.type === 'url') return <Tag color="purple">URL</Tag>
  return <Tag>本地</Tag>
}

/** Skills 管理:安装、导入、启用、更新、卸载 */
function SkillsPanel(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const skills = useSkills()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 安装确认框状态
  const [discover, setDiscover] = useState<DiscoverResult | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)

  const openCandidates = (result: DiscoverResult): void => {
    setDiscover(result)
    setSelected(result.candidates.filter((c) => !c.error).map((c) => c.name))
  }

  const handleDiscover = async (): Promise<void> => {
    if (!input.trim()) return
    setBusy(true)
    try {
      const res = await window.api.skills.discover(input)
      if (!res.success) {
        message.error(res.msg)
        return
      }
      openCandidates(res.data)
    } finally {
      setBusy(false)
    }
  }

  const handleImportLocal = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.skills.importLocal()
      if (!res.success) {
        message.error(res.msg)
        return
      }
      if (res.data) openCandidates(res.data)
    } finally {
      setBusy(false)
    }
  }

  const closeCandidates = (): void => {
    if (discover) void window.api.skills.cancel(discover.sessionId)
    setDiscover(null)
  }

  const handleInstall = async (): Promise<void> => {
    if (!discover || selected.length === 0) return
    const overwriting = discover.candidates.filter((c) => selected.includes(c.name) && c.exists)
    if (overwriting.length > 0) {
      const ok = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '覆盖已安装的 skill',
          content: `${overwriting.map((c) => c.name).join('、')} 已存在,继续将覆盖。`,
          okText: '覆盖',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
      if (!ok) return
    }
    setInstalling(true)
    try {
      const res = await window.api.skills.install(discover.sessionId, selected, true)
      if (!res.success) {
        message.error(res.msg)
        return
      }
      message.success(`已安装 ${res.data.installed.join('、')}`)
      setDiscover(null)
      setInput('')
    } finally {
      setInstalling(false)
    }
  }

  const handleToggle = async (skill: SkillMeta, enabled: boolean): Promise<void> => {
    const res = await window.api.skills.setEnabled(skill.name, enabled)
    if (!res.success) message.error(res.msg)
  }

  const handleUpdate = async (skill: SkillMeta): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.skills.update(skill.name)
      if (res.success) message.success(`${skill.name} 已更新`)
      else message.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  const handleUninstall = (skill: SkillMeta): void => {
    modal.confirm({
      title: `卸载 ${skill.name}`,
      content: '将删除该 skill 的目录,确定吗?',
      okText: '卸载',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const res = await window.api.skills.uninstall(skill.name)
        if (!res.success) message.error(res.msg)
      }
    })
  }

  const handleOpenDir = async (): Promise<void> => {
    const res = await window.api.skills.openDir()
    if (!res.success) message.error(res.msg)
  }

  return (
    <Flex vertical gap="middle" style={{ maxWidth: 760 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Skill 是一份给模型的操作指南(SKILL.md)。可从 GitHub 仓库(owner/repo 或链接)、zip
        直链安装,也可以导入本地文件夹,或直接把 skill 目录放进 skills 文件夹。
      </Typography.Paragraph>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={handleDiscover}
          placeholder="anthropics/skills 或 https://github.com/owner/repo/tree/main/path"
          disabled={busy}
        />
        <Button
          type="primary"
          icon={<CloudDownloadOutlined />}
          loading={busy}
          onClick={handleDiscover}
        >
          安装
        </Button>
      </Space.Compact>
      <Space>
        <Button icon={<ImportOutlined />} disabled={busy} onClick={handleImportLocal}>
          导入本地
        </Button>
        <Button icon={<FolderOpenOutlined />} onClick={handleOpenDir}>
          打开 skills 目录
        </Button>
      </Space>

      <List
        size="small"
        bordered
        locale={{ emptyText: '尚未安装任何 skill' }}
        dataSource={skills}
        renderItem={(s) => (
          <List.Item
            actions={[
              s.source.type !== 'local' && !s.error ? (
                <Button key="update" type="link" size="small" disabled={busy} onClick={() => handleUpdate(s)}>
                  更新
                </Button>
              ) : null,
              <Button key="remove" type="link" size="small" danger onClick={() => handleUninstall(s)}>
                卸载
              </Button>,
              <Switch
                key="enabled"
                size="small"
                checked={s.enabled}
                disabled={!!s.error}
                onChange={(v) => handleToggle(s, v)}
              />
            ].filter(Boolean)}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span>{s.name}</span>
                  {sourceTag(s.source)}
                </Space>
              }
              description={
                s.error ? (
                  <Typography.Text type="danger">无法加载:{s.error}</Typography.Text>
                ) : (
                  s.description
                )
              }
            />
          </List.Item>
        )}
      />

      <Modal
        title="选择要安装的 skill"
        open={discover !== null}
        onCancel={closeCandidates}
        onOk={handleInstall}
        okText={`安装 ${selected.length} 个`}
        okButtonProps={{ disabled: selected.length === 0 }}
        confirmLoading={installing}
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        {discover && (
          <Flex vertical gap="small" style={{ maxHeight: 480, overflow: 'auto' }}>
            <Alert
              type="warning"
              showIcon
              message="skill 的内容会作为指令发送给模型,安装前请确认来源可信。"
            />
            {discover.candidates.map((c) => (
              <div
                key={c.relPath}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                  padding: token.paddingSM
                }}
              >
                <Checkbox
                  checked={selected.includes(c.name)}
                  disabled={!!c.error}
                  onChange={(e) =>
                    setSelected((prev) =>
                      e.target.checked ? [...prev, c.name] : prev.filter((n) => n !== c.name)
                    )
                  }
                >
                  <Space>
                    <Typography.Text strong>{c.name}</Typography.Text>
                    {c.exists && <Tag color="orange">已安装,将覆盖</Tag>}
                  </Space>
                </Checkbox>
                {c.error ? (
                  <Typography.Paragraph type="danger" style={{ margin: '4px 0 0 24px' }}>
                    {c.error}
                  </Typography.Paragraph>
                ) : (
                  <>
                    <Typography.Paragraph style={{ margin: '4px 0 0 24px' }}>
                      {c.description}
                    </Typography.Paragraph>
                    {c.bodyPreview && (
                      <Typography.Paragraph
                        type="secondary"
                        ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
                        style={{ margin: '0 0 0 24px', whiteSpace: 'pre-wrap', fontSize: 12 }}
                      >
                        {c.bodyPreview}
                      </Typography.Paragraph>
                    )}
                  </>
                )}
              </div>
            ))}
          </Flex>
        )}
      </Modal>
    </Flex>
  )
}

export default SkillsPanel
