// 插件的 HTTP 半边：给侧栏「提示词工作台」页面用（/image-prompt-studio/ 下）。
//   GET  /                    工作台页面（lab/ 静态资源）
//   GET  /api/status          版本/数据目录/apiz 配置状态/统计
//   GET  /api/presets         预设列表（内置 + 用户自存）
//   GET  /api/preset?name=    取一份预设完整 JSON
//   POST /api/presets         保存用户预设 {name, data}
//   POST /api/preset/remove   删除用户预设 {name}
//   POST /api/validate        结构校验（与 ips_validate 同引擎）
//   POST /api/diff            冻结度比对（与 ips_diff 同引擎）
//   GET  /api/history         生成历史 + 统计；POST /api/history/remove、/api/history/clear
//   POST /api/generate        发起出图任务（异步 job，生成要几分钟）
//   GET  /api/job?id=         任务进度
//   GET  /media?path=         成图预览（只允许数据目录 images/ 内的文件）
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePrompt, validatePrompt, diffPrompts } from './check.js'
import { IMAGES_DIR, UPLOADS_DIR, listPresets, getPreset, savePreset, deletePreset, readHistory, removeRecord, clearHistory, summarizeHistory, readStyle, saveStyle, clearStyle, saveUploadDataUrl, listStyles, saveStyleToLibrary, deleteStyle } from './data.js'
import { runGenerate } from './generate.js'
import { resolveApizApiKey } from './image/apizUpload.js'
import { TOOLS, configRef } from './tools.js'

const BASE = '/image-prompt-studio'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))
const TOOL = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function version() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return null }
}

// 只放行 lab/ 里的文件：拒绝 ..、点开头的路径和指到目录外的符号链接
function safeLabFile(rel) {
  if (!rel || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(LAB) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serve(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('需要 JSON'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- 出图任务（生成要 2-9 分钟，异步 job + 页面轮询）
const jobs = new Map()
let seq = 0

function startGenerateJob(args) {
  const id = `job-${Date.now().toString(36)}-${++seq}`
  const job = { id, status: 'running', startedAt: new Date().toISOString() }
  jobs.set(id, job)
  if (jobs.size > 40) jobs.delete(jobs.keys().next().value)
  Promise.resolve()
    .then(() => runGenerate(args, configRef.config ?? {}))
    .then(({ record, files }) => {
      job.status = 'done'
      job.record = record
      job.files = files
    })
    .catch((err) => {
      job.status = 'failed'
      job.error = String((err && err.message) || err)
    })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return job
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping') return json(res, 200, { ok: true, version: version() })

        if (rest === '/api/status' && req.method === 'GET') {
          const config = configRef.config ?? {}
          const auth = resolveApizApiKey(config.apizApiKey, { allowCliAuth: config.apizUseCliAuth === true })
          const history = readHistory()
          return json(res, 200, {
            ok: true,
            version: version(),
            dataDir: dirname(IMAGES_DIR),
            imagesDir: IMAGES_DIR,
            auth: { configured: Boolean(auth.key), source: auth.source },
            defaultModel: config.defaultModel || undefined,
            quality: config.quality || undefined,
            stats: summarizeHistory(history),
          })
        }

        if (rest === '/api/presets' && req.method === 'GET') {
          return json(res, 200, { ok: true, presets: listPresets() })
        }

        if (rest === '/api/preset' && req.method === 'GET') {
          const preset = getPreset(url.searchParams.get('name') || '')
          return preset ? json(res, 200, { ok: true, name: preset.name, builtin: preset.builtin, data: preset.data })
            : json(res, 404, { ok: false, error: '没有这个预设' })
        }

        if (rest === '/api/presets' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          if (!body.data || typeof body.data !== 'object') return json(res, 400, { ok: false, error: '需要 data（提示词 JSON 对象）' })
          try {
            const saved = savePreset(body.name, body.data)
            return json(res, 200, { ok: true, ...saved })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/preset/remove' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          return json(res, deletePreset(String(body.name || '')) ? 200 : 404, { ok: true })
        }

        if (rest === '/api/style' && req.method === 'GET') {
          return json(res, 200, { ok: true, style: readStyle() })
        }

        if (rest === '/api/style' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          if (!body.prompt || typeof body.prompt !== 'object') return json(res, 400, { ok: false, error: '需要 prompt（风格提示词 JSON 对象）' })
          if (!body.referenceImage) return json(res, 400, { ok: false, error: '需要 referenceImage（参考图绝对路径）' })
          try {
            return json(res, 200, { ok: true, style: saveStyle({ prompt: body.prompt, referenceImage: String(body.referenceImage), note: body.note ? String(body.note) : undefined }) })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/style/clear' && req.method === 'POST') {
          await readJson(req).catch(() => ({}))
          return json(res, 200, { ok: true, cleared: clearStyle() })
        }

        // 面板文件选择 → 落盘 uploads/（agent 读这个路径做风格分析；出图时同路径传回）
        if (rest === '/api/style/upload' && req.method === 'POST') {
          const body = await readJson(req, 30 * 1024 * 1024).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          try {
            const file = saveUploadDataUrl(body.dataUrl, body.name)
            return json(res, 200, { ok: true, file })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/styles' && req.method === 'GET') {
          return json(res, 200, { ok: true, styles: listStyles() })
        }

        // 把「当前风格槽」存入风格库（面板第 1 步的保存按钮）
        if (rest === '/api/styles' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const current = body.prompt && typeof body.prompt === 'object'
            ? { prompt: body.prompt, referenceImage: body.referenceImage, note: body.note }
            : readStyle()
          if (!current || !current.prompt) return json(res, 400, { ok: false, error: '还没有可保存的风格：先完成第 1 步' })
          try {
            return json(res, 200, { ok: true, style: saveStyleToLibrary({ name: body.name, prompt: current.prompt, referenceImage: current.referenceImage, note: current.note }) })
          } catch (err) {
            return json(res, 400, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/styles/delete' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          return json(res, deleteStyle(String(body.id || '')) ? 200 : 404, { ok: true })
        }

        if (rest === '/api/validate' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          try {
            const data = parsePrompt(body.prompt)
            const report = validatePrompt(data, { partial: body.partial === true })
            return json(res, 200, { ok: true, report })
          } catch (err) {
            return json(res, 200, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/diff' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          try {
            const before = parsePrompt(body.before)
            const after = parsePrompt(body.after)
            const diff = diffPrompts(before, after)
            // 页面只要摘要：改动字段清单不塞全文
            return json(res, 200, {
              ok: true,
              diff: {
                totalLeaves: diff.totalLeaves,
                frozenRate: diff.frozenRate,
                changed: diff.changed.map((c) => ({ path: c.path, before: c.before.slice(0, 80), after: c.after.slice(0, 80) })),
                frozenCount: diff.frozen.length,
                added: diff.added,
                removed: diff.removed,
              },
            })
          } catch (err) {
            return json(res, 200, { ok: false, error: String(err.message || err) })
          }
        }

        if (rest === '/api/history' && req.method === 'GET') {
          const all = readHistory()
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60))
          return json(res, 200, { ok: true, list: all.slice(0, limit), stats: summarizeHistory(all), total: all.length })
        }

        if (rest === '/api/history/remove' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          const removed = removeRecord(String(body.id || ''))
          return json(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '没有这条记录' })
        }

        if (rest === '/api/history/clear' && req.method === 'POST') {
          await readJson(req).catch(() => ({}))
          return json(res, 200, { ok: true, removed: clearHistory() })
        }

        if (rest === '/api/generate' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return json(res, body.status || 400, { ok: false, error: body.message })
          if (!body.prompt) return json(res, 400, { ok: false, error: '需要 prompt（结构化 JSON 提示词原文）' })
          const job = startGenerateJob({
            prompt: body.prompt,
            extraRequirements: typeof body.extraRequirements === 'string' ? body.extraRequirements : undefined,
            model: body.model ? String(body.model) : undefined,
            quality: body.quality ? String(body.quality) : undefined,
            aspectRatio: body.aspectRatio ? String(body.aspectRatio) : undefined,
            sizeTier: body.sizeTier ? String(body.sizeTier) : undefined,
            referenceImages: Array.isArray(body.referenceImages) ? body.referenceImages.map(String) : [],
          })
          return json(res, 200, { ok: true, job: job.id })
        }

        if (rest === '/api/job' && req.method === 'GET') {
          const job = jobs.get(url.searchParams.get('id') || '')
          return job ? json(res, 200, { ok: true, job }) : json(res, 404, { ok: false, error: '没有这个任务' })
        }

        if (rest === '/media') {
          const target = url.searchParams.get('path')
          if (!target || !isAbsolute(target) || !existsSync(target)) return json(res, 404, { ok: false, error: 'not found' })
          const file = realpathSync(target)
          // 成图目录 + 参考图上传目录都在白名单（风格卡缩略图/预览用）
          const roots = [realpathSync(IMAGES_DIR), realpathSync(UPLOADS_DIR)]
          if (!roots.some((root) => file === root || file.startsWith(root + sep))) return json(res, 403, { ok: false, error: 'forbidden' })
          if (!statSync(file).isFile()) return json(res, 404, { ok: false, error: 'not found' })
          return serve(req, res, file)
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只读接口' })
        if (rest.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })

        // 静态页面：/ → index.html
        const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
        const file = safeLabFile(rel)
        return file ? serve(req, res, file) : json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  })
}

// dsh 0.2.x 宿主自带 token 鉴权；connection 服务缺席时放行（和 stock-research 一致）。
function requestRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}

export { TOOL }
