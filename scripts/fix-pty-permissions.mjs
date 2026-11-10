/**
 * node-pty 1.1.0 把 prebuilds/*\/spawn-helper 发布成 644，而 posix_spawnp 要求它可执行。
 * 不改权限的话，第一次 spawn 就是 `posix_spawnp failed`——安装脚本不会替我们补这一位。
 * 放在 postinstall 里做，而不是运行时改：打包时 electron-builder 按源文件的 mode 拷贝，
 * 先在这里加好，app.asar.unpacked 里那份才带着执行位；运行时去改包内文件还会破坏签名。
 * Windows 走 conpty，没有这个文件，直接跳过。
 */
import fs from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  const helper = path.join(
    import.meta.dirname,
    '..',
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper'
  )

  try {
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  } catch (error) {
    // 没装 node-pty（例如只跑测试的环境）不该让 npm install 失败
    console.warn(`[fix-pty-permissions] 无法给 spawn-helper 加执行权限：${error.message}`)
  }
}
