import { readOnlyCommandRejection } from '../../../src/main/tools/plan'

describe('readOnlyCommandRejection:计划阶段只放行证明得了只读的命令', () => {
  it('查看 / 检索 / 统计类命令放行', () => {
    expect(readOnlyCommandRejection('rg TODO src')).toBeNull()
    expect(readOnlyCommandRejection('ls -la src')).toBeNull()
    expect(readOnlyCommandRejection('git status')).toBeNull()
    expect(readOnlyCommandRejection('git log --oneline -20')).toBeNull()
    expect(readOnlyCommandRejection('cat package.json')).toBeNull()
  })

  it('git branch 的无参 / -a / -r / --show-current / --list 放行', () => {
    expect(readOnlyCommandRejection('git branch')).toBeNull()
    expect(readOnlyCommandRejection('git branch -a')).toBeNull()
    expect(readOnlyCommandRejection('git branch -r')).toBeNull()
    expect(readOnlyCommandRejection('git branch --show-current')).toBeNull()
    expect(readOnlyCommandRejection('git branch --list "feat-*"')).toBeNull()
  })

  it('git branch <name> 被拒:classifyCommand 判它低风险,但它会创建 / 移动分支', () => {
    expect(readOnlyCommandRejection('git branch new-feature')).toContain('不允许')
    // `-d` 更早被 classifyCommand 拦下,结论同样是拒绝,只是理由指向那个选项
    expect(readOnlyCommandRejection('git branch -d old')).toContain('计划阶段')
  })

  it('git remote 只有无参 / -v / show / get-url 放行', () => {
    expect(readOnlyCommandRejection('git remote')).toBeNull()
    expect(readOnlyCommandRejection('git remote -v')).toBeNull()
    expect(readOnlyCommandRejection('git remote show origin')).toBeNull()
    expect(readOnlyCommandRejection('git remote get-url origin')).toBeNull()
    expect(readOnlyCommandRejection('git remote add upstream https://x')).toContain('不允许')
    expect(readOnlyCommandRejection('git remote set-url origin https://x')).toContain('不允许')
  })

  it('写、删、安装、推送类命令被拒,理由指向只读要求', () => {
    expect(readOnlyCommandRejection('rm -rf out')).toContain('只允许证明得了只读的命令')
    expect(readOnlyCommandRejection('git push')).toContain('只允许证明得了只读的命令')
    expect(readOnlyCommandRejection('npm install')).toContain('只允许证明得了只读的命令')
  })

  it('重定向、管道给 shell、参数即代码都被拒', () => {
    expect(readOnlyCommandRejection('cat a > b')).toContain('只允许证明得了只读的命令')
    expect(readOnlyCommandRejection('rg x | sh')).toContain('只允许证明得了只读的命令')
    expect(readOnlyCommandRejection('bash -c "rm -rf ~"')).toContain('只允许证明得了只读的命令')
  })

  it('多段命令里任一段不满足就整条拒绝', () => {
    expect(readOnlyCommandRejection('ls && git branch new')).toContain('不允许')
    expect(readOnlyCommandRejection('git status; rm -rf out')).toContain('计划阶段')
  })

  it('空命令给一句陈述而不是放行', () => {
    expect(readOnlyCommandRejection('   ')).toContain('命令是空的')
  })

  it('拒绝句不含祈使:与工具结果那份文案同一条纪律', () => {
    const sample = [
      readOnlyCommandRejection('rm -rf out'),
      readOnlyCommandRejection('git branch new'),
      readOnlyCommandRejection('git remote add x y'),
      readOnlyCommandRejection('')
    ]
    for (const text of sample) {
      expect(text).toBeTruthy()
      expect(text).not.toMatch(/请|务必|必须|应该|记得|不要|改用|换用/)
    }
  })
})
