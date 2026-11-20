// 面板「设置」页的读写：apiz 生图相关配置（Key / 地址 / 模型 / 质量 / CLI 复用 / 超时）。
//
// 写配置统一走宿主的 config-editor 服务：它把改动落到 profile patch 的对应行，再让 Loader
// 热应用（插件重启 → apply 重跑 → configRef 换成新配置）。不自己改 YAML —— 那样容易把
// !!js 表达式、注释或更高层的覆盖搞坏（与 dsh-amazon-image-studio 的 settings.js 同一套做法）。
//
// Key 的解析优先级仍然是「插件配置 > 环境变量 APIZ_API_KEY > 本机 apiz CLI 登录态（需显式开启）」，
// 见 image/apizUpload.js 的 resolveApizApiKey；这里只负责读状态与写入。
import { DEFAULT_APIZ_BASE_URL, DEFAULT_APIZ_MODEL, APIZ_QUALITIES, normalizeApizQuality } from './image/apiz.js'
import { readApizCliApiKey, resolveApizApiKey } from './image/apizUpload.js'
import { configRef } from './tools.js'

// 面板可写的字段白名单（写别的字段一律拒绝，避免把插件配置当任意写入口）
const EDITABLE = ['apizApiKey', 'apizBaseUrl', 'apizUseCliAuth', 'defaultModel', 'quality', 'apizBin', 'timeoutSeconds']

// bundle patch 里本插件行的 id / name（找配置行时两者都认，profile 手写过 override 也不会漏）
const ENTRY_ID = 'image-prompt-studio'
const ENTRY_NAMES = ['dsh-image-prompt-studio', 'image-prompt-studio']

const MODELS = [
  { id: 'apiz/gpt-image-2.5-flare', label: 'GPT-Image 2.5 flare（apiz 默认路线）' },
  { id: 'apiz/gpt-image-2.5-sunburst', label: 'GPT-Image 2.5 sunburst（备选）' },
  { id: 'service-inference/gemini-nano-banana-2.1', label: 'Nano Banana 2.1' },
  { id: 'fal-ai/nano-banana-pro', label: 'Nano Banana Pro（较贵）' },
]

export function maskSecret(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

function configEditor(ctx) {
  if (typeof ctx?.get !== 'function') return null
  const editor = ctx.get('configEditor')
  return editor && typeof editor.edit === 'function' && typeof editor.entries === 'function' ? editor : null
}

export function settingsAvailable(ctx) {
  return configEditor(ctx) !== null
}

/** 本插件的配置行：优先用插件自己的 loader entry（dsh 文档推荐的自身配置出口），再退回按 id/name 扫。 */
function findEntry(ctx) {
  const own = ctx?.fiber?.entry
  if (own && typeof own === 'object' && own.options) {
    const id = String(own.options.id ?? '')
    const name = String(own.options.name ?? '')
    if (id === ENTRY_ID || ENTRY_NAMES.includes(name)) return own
  }
  const editor = configEditor(ctx)
  if (!editor) return null
  let rows = []
  try { rows = editor.entries() ?? [] } catch { return null }
  return rows.find((row) => row?.options?.id === ENTRY_ID)
    ?? rows.find((row) => ENTRY_NAMES.includes(String(row?.options?.name ?? '')))
    ?? null
}

function seconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 900
  return Math.round(Math.max(30, Math.min(3600, n)))
}

/** 当前设置（Key 只回脱敏值，绝不回原文）。override 用于保存后回显「刚写进去的那份」。 */
export function readSettings(ctx, override) {
  const config = (override && typeof override === 'object' ? override : configRef.config) ?? {}
  const auth = resolveApizApiKey(config.apizApiKey, { allowCliAuth: config.apizUseCliAuth === true })
  const entry = findEntry(ctx)
  return {
    available: settingsAvailable(ctx),
    entryId: entry?.options?.id ?? null,
    apiz: {
      apiKey: maskSecret(config.apizApiKey),
      hasApiKey: Boolean(String(config.apizApiKey ?? '').trim()),
      // 当前真正会被用去的 Key 来自哪一层：config / env / apiz-cli / none
      keySource: auth.source,
      configured: Boolean(auth.key),
      envKeyPresent: Boolean(String(process.env.APIZ_API_KEY ?? '').trim()),
      cliKeyPresent: Boolean(readApizCliApiKey()),
      useCliAuth: config.apizUseCliAuth === true,
      baseUrl: String(config.apizBaseUrl ?? '').trim() || DEFAULT_APIZ_BASE_URL,
      bin: String(config.apizBin ?? '').trim(),
      timeoutSeconds: seconds(config.timeoutSeconds),
    },
    model: String(config.defaultModel ?? '').trim() || DEFAULT_APIZ_MODEL,
    quality: normalizeApizQuality(config.quality),
    qualities: APIZ_QUALITIES,
    models: MODELS,
    defaultModel: DEFAULT_APIZ_MODEL,
  }
}

function pick(patch) {
  const next = {}
  for (const key of EDITABLE) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (key === 'apizApiKey') {
      if (typeof value !== 'string') throw new Error('apizApiKey 必须是字符串')
      next[key] = value.trim() // 空串 = 清空已保存的 Key
      continue
    }
    if (key === 'apizBaseUrl') {
      if (typeof value !== 'string') throw new Error('apizBaseUrl 必须是字符串')
      const url = value.trim()
      if (url && !/^https?:\/\//i.test(url)) throw new Error('apizBaseUrl 需要是 http(s):// 开头的地址（留空用默认）')
      next[key] = url
      continue
    }
    if (key === 'defaultModel') {
      if (typeof value !== 'string') throw new Error('defaultModel 必须是字符串')
      next[key] = value.trim() // 空串 = 回落默认模型
      continue
    }
    if (key === 'quality') {
      const quality = String(value).trim().toLowerCase()
      if (!APIZ_QUALITIES.includes(quality)) throw new Error(`quality 只能是 ${APIZ_QUALITIES.join(' / ')}`)
      next[key] = quality
      continue
    }
    if (key === 'apizBin') {
      if (typeof value !== 'string') throw new Error('apizBin 必须是字符串')
      next[key] = value.trim()
      continue
    }
    if (key === 'timeoutSeconds') {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 30 || n > 3600) throw new Error('timeoutSeconds 需在 30-3600 之间')
      next[key] = Math.round(n)
      continue
    }
    // apizUseCliAuth
    next[key] = value === true
  }
  if (!Object.keys(next).length) throw new Error('没有任何可保存的字段')
  return next
}

/** 保存设置：写 profile patch → Loader 热应用（插件重启，configRef 换成新值）。 */
export async function saveSettings(ctx, patch) {
  // 先校验入参（与宿主能力无关），报错才说的是「字段不对」而不是「服务没有」
  const next = pick(patch ?? {})
  const editor = configEditor(ctx)
  if (!editor) {
    throw new Error('宿主没有 config-editor 服务（dsh 版本较老）：请在 profile 的 cordis.patch.yml 里手写 image-prompt-studio 的 config 段，或升级 dsh')
  }
  const entry = findEntry(ctx)
  if (!entry) {
    throw new Error(`找不到本插件的配置行（id: ${ENTRY_ID}）：当前 profile 可能没有通过 bundle patch 挂载这个插件`)
  }
  await editor.edit(entry, (current) => ({ ...current, ...next }))
  // 写完立刻回显「写入后的配置」：Loaders 重启插件的时机由宿主决定，不能拿旧 configRef 欺骗用户
  const written = { ...(configRef.config ?? {}), ...next }
  return readSettings(ctx, written)
}
