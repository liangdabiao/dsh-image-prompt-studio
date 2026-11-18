// 数据层：预设库（内置 9 套 + 用户自存）与生成历史（$DSH_HOME/image-prompt-studio/）。
// 内置预设只读（save 同名会另存用户副本，不覆盖上游资产）；用户预设可增删。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'image-prompt-studio')
export const PRESETS_DIR = join(DATA_DIR, 'presets')
export const IMAGES_DIR = join(DATA_DIR, 'images')
export const UPLOADS_DIR = join(DATA_DIR, 'uploads')
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const STYLE_FILE = join(DATA_DIR, 'style.json')
const BUILTIN_PRESETS_DIR = fileURLToPath(new URL('../skills/image-prompt-studio/assets/presets/', import.meta.url))

export function ensureDirs() {
  for (const dir of [DATA_DIR, PRESETS_DIR, IMAGES_DIR, UPLOADS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

// 原子写：先写 .tmp 再 rename，避免并发读写截断。
export function atomicWrite(file, value) {
  writeFileSync(`${file}.tmp`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  renameSync(`${file}.tmp`, file)
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 预设库

const safePresetName = (name) => String(name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)

function presetSummaries(dir, builtin) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => {
      const data = readJsonSafe(join(dir, d.name))
      return {
        name: d.name.replace(/\.json$/, ''),
        file: join(dir, d.name),
        builtin,
        partial: Boolean(data && !('风格模式' in data)),
        updatedAt: statSync(join(dir, d.name)).mtime.toISOString(),
        summary: data && typeof data === 'object' ? (data['风格模式'] || data?.场景?.主体?.整体描述 || '') : '',
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 内置 9 套 + 用户自存（同名时用户侧条目标注 override）。 */
export function listPresets() {
  const builtin = presetSummaries(BUILTIN_PRESETS_DIR, true)
  const user = presetSummaries(PRESETS_DIR, false)
  const builtinNames = new Set(builtin.map((p) => p.name))
  for (const p of user) p.override = builtinNames.has(p.name)
  return [...builtin, ...user]
}

/** 取一份预设（用户同名优先——允许在内置基础上改出用户版）。 */
export function getPreset(name) {
  const clean = safePresetName(name)
  for (const dir of [PRESETS_DIR, BUILTIN_PRESETS_DIR]) {
    const file = join(dir, `${clean}.json`)
    if (existsSync(file)) {
      const data = readJsonSafe(file)
      if (data) return { name: clean, builtin: dir === BUILTIN_PRESETS_DIR, data }
    }
  }
  return null
}

/** 保存用户预设；builtin=true 拒绝（内置只读）。 */
export function savePreset(name, data, { builtin = false } = {}) {
  if (builtin) throw new Error('内置预设只读：请换一个名字保存为用户预设')
  const clean = safePresetName(name)
  if (!clean) throw new Error('预设名不能为空')
  ensureDirs()
  const file = join(PRESETS_DIR, `${clean}.json`)
  atomicWrite(file, data)
  return { name: clean, file, builtin: false }
}

export function deletePreset(name) {
  const clean = safePresetName(name)
  const file = join(PRESETS_DIR, `${clean}.json`)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

// ---------------------------------------------------------------- 当前风格槽（两步向导的枢纽）
// Step1 agent 读参考图分析出风格 JSON 后，调 ips_style（action=set）写回这里；
// Step2 面板读这里显示「风格就绪」卡并带参考图出图。单槽：新风格覆盖旧的（换风格=重跑 Step1）。

export function readStyle() {
  if (!existsSync(STYLE_FILE)) return null
  const data = readJsonSafe(STYLE_FILE)
  return data || null
}

/** style: { prompt: object, referenceImage: string, note?: string }；写入时补 updatedAt。 */
export function saveStyle(style) {
  ensureDirs()
  if (!style || typeof style.prompt !== 'object' || !style.prompt) throw new Error('风格提示词必须是 JSON 对象')
  const full = { ...style, updatedAt: new Date().toISOString() }
  atomicWrite(STYLE_FILE, full)
  return full
}

export function clearStyle() {
  if (!existsSync(STYLE_FILE)) return false
  unlinkSync(STYLE_FILE)
  return true
}

// ---------------------------------------------------------------- 参考图上传（面板 File 选择的落盘处，agent 直接读这个路径）

const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

/** data URL → UPLOADS_DIR 下的本地文件；返回绝对路径（agent 读图分析/出图传回都用它）。 */
export function saveUploadDataUrl(dataUrl, originalName = '') {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''))
  if (!match) throw new Error('上传必须是图片 data URL')
  const [, mime, base64] = match
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) throw new Error('上传内容为空')
  if (buffer.length > 20 * 1024 * 1024) throw new Error('参考图超过 20MB，请压缩后再传')
  ensureDirs()
  const ext = EXT_BY_MIME[mime.toLowerCase()] ?? (/\.[a-z0-9]+$/i.exec(String(originalName))?.[0]?.toLowerCase() || '.png')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const file = join(UPLOADS_DIR, `ref-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  writeFileSync(file, buffer)
  return file
}

// ---------------------------------------------------------------- 生成历史

function readHistoryFile() {
  if (!existsSync(HISTORY_FILE)) return []
  return readJsonSafe(HISTORY_FILE) || []
}

export function readHistory() {
  return readHistoryFile()
}

export function addHistoryRecord(record) {
  ensureDirs()
  const list = readHistoryFile()
  const full = {
    id: `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...record,
  }
  list.unshift(full)
  atomicWrite(HISTORY_FILE, list.slice(0, 500))
  return full
}

export function removeRecord(id) {
  const list = readHistoryFile()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) return false
  atomicWrite(HISTORY_FILE, next)
  return true
}

export function clearHistory() {
  ensureDirs()
  const removed = readHistoryFile().length
  atomicWrite(HISTORY_FILE, [])
  return removed
}

export function summarizeHistory(list) {
  const ok = list.filter((r) => r.ok)
  return {
    total: list.length,
    ok: ok.length,
    failed: list.length - ok.length,
    credits: ok.reduce((n, r) => n + (typeof r.price === 'number' ? r.price : 0), 0),
    models: [...new Set(ok.map((r) => r.model).filter(Boolean))],
  }
}
