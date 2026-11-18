// 参考图上传：data URL → apiz CDN 公网 URL（apiz 的参考图参数只收公网 HTTP(S) URL）。
//
// 走本机 apiz CLI 的 `upload` 子命令（免费，且认证由 CLI 自己管：apiz auth login / APIZ_API_KEY）。
// 上传结果按内容哈希缓存：同一张参考图反复出图时不必重复上传。
// 移植自 dsh-ecom-visual-copy/lib/image/apizUpload.js（上传目录前缀改为本插件）。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataUrlToBuffer } from './shared.js'

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const UPLOAD_FOLDER = 'dsh-image-prompt-studio'
const CACHE_LIMIT = 64

// 进程内缓存：hash → public_url（插件生命周期内复用；重启后由 CLI 重新上传）
const uploadCache = new Map()

export function clearApizUploadCache() {
  uploadCache.clear()
}

export function resolveApizBin(explicit) {
  const value = String(explicit ?? '').trim()
  if (value) return value
  if (process.env.APIZ_BIN) return process.env.APIZ_BIN.trim()
  return 'apiz' // Windows 上 CreateProcess 会补 .exe
}

function parseUploadOutput(raw) {
  const text = String(raw ?? '').trim()
  const brace = text.indexOf('{')
  if (brace < 0) throw new Error(`apiz upload 没有返回 JSON：${text.slice(0, 300)}`)
  const parsed = JSON.parse(text.slice(brace))
  const url = parsed?.public_url ?? parsed?.data?.public_url ?? parsed?.url
  if (!url) throw new Error(`apiz upload 结果缺少 public_url：${text.slice(0, 300)}`)
  return url
}

function runApizUpload(file, bin, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['upload', file, '--folder', UPLOAD_FOLDER, '--json'],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || stdout || error.message).trim().slice(0, 600)
          if (error.code === 'ENOENT') {
            reject(new Error(`找不到 apiz CLI（${bin}）：参考图必须先传到 apiz CDN 才能图生图。装好 apiz CLI 并 apiz auth login，或用插件设置 apizBin 指定路径；也可以直接给出 http(s) 图片 URL 免上传。`))
            return
          }
          reject(new Error(`apiz upload 失败：${message}`))
          return
        }
        try {
          resolve(parseUploadOutput(stdout))
        } catch (err) {
          reject(err)
        }
      },
    )
  })
}

function extensionOf(dataUrl) {
  const mime = /^data:([^;,]+)/i.exec(String(dataUrl))?.[1]?.toLowerCase()
  return EXT_BY_MIME[mime] ?? 'png'
}

/** 单张 data URL → 公网 URL（带内容哈希缓存）。 */
export async function uploadDataUrlToApiz(dataUrl, options = {}) {
  const buffer = dataUrlToBuffer(dataUrl)
  if (!buffer.length) throw new Error('参考图是空的，无法上传')
  const hash = createHash('sha1').update(buffer).digest('hex')
  const cached = uploadCache.get(hash)
  if (cached) return cached

  // 测试/嵌入场景可注入上传器，免得单测真的起 apiz CLI
  const uploader = typeof options.uploader === 'function' ? options.uploader : null
  const bin = resolveApizBin(options.bin)
  const timeoutMs = options.timeoutMs ?? 120_000
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ips-apiz-'))
  const file = join(dir, `ref-${hash.slice(0, 12)}.${extensionOf(dataUrl)}`)
  try {
    writeFileSync(file, buffer)
    const url = uploader ? await uploader(dataUrl, { file, buffer }) : await runApizUpload(file, bin, timeoutMs)
    if (!url) throw new Error('参考图上传没有拿到公网 URL')
    if (uploadCache.size >= CACHE_LIMIT) uploadCache.delete(uploadCache.keys().next().value)
    uploadCache.set(hash, url)
    return url
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响主流程 */ }
  }
}

/** 本机 apiz CLI 的登录态（~/.config/apiz/config.toml）里的 api_key；没有就返回空串。 */
export function readApizCliApiKey() {
  // APIZ_CONFIG 显式指定时**只用它**：否则隔离环境（单测/沙盒）会悄悄回落到用户真实登录态
  const override = String(process.env.APIZ_CONFIG ?? '').trim()
  const candidates = override ? [override] : [join(homedir(), '.config', 'apiz', 'config.toml')]
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    try {
      const text = `\n${readFileSync(file, 'utf8')}`
      const match = /api_key\s*=\s*"([^"]+)"/.exec(text)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch { /* 读不到就当下一个 */ }
  }
  return ''
}

/**
 * API Key 解析（优先级：插件配置 > 环境变量 > 本机 apiz CLI 登录态）。
 * CLI 登录态默认**不自动复用**：插件设置里 apizUseCliAuth 打开才用（默认关，避免"没配置也在花钱"）。
 */
export function resolveApizApiKey(explicit, options = {}) {
  const fromConfig = String(explicit ?? '').trim()
  if (fromConfig) return { key: fromConfig, source: 'config' }
  const fromEnv = String(process.env.APIZ_API_KEY ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  if (options.allowCliAuth === true) {
    const fromCli = readApizCliApiKey()
    if (fromCli) return { key: fromCli, source: 'apiz-cli' }
  }
  return { key: '', source: 'none' }
}
