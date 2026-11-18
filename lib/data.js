// 数据层：预设库（内置 9 套 + 用户自存）与生成历史（$DSH_HOME/image-prompt-studio/）。
// 内置预设只读（save 同名会另存用户副本，不覆盖上游资产）；用户预设可增删。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'image-prompt-studio')
export const PRESETS_DIR = join(DATA_DIR, 'presets')
export const IMAGES_DIR = join(DATA_DIR, 'images')
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const BUILTIN_PRESETS_DIR = fileURLToPath(new URL('../skills/image-prompt-studio/assets/presets/', import.meta.url))

export function ensureDirs() {
  for (const dir of [DATA_DIR, PRESETS_DIR, IMAGES_DIR]) {
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
