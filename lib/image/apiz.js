// apiz 异步生图适配器（双模型家族）：POST /api/v3/tasks/create → 轮询 /api/v3/tasks/query → 返回成图 URL。
//
// 与上游 dsh-ecom-visual-copy 的单 GPT-Image 适配器的差别：
//   1. 双家族参数名：GPT-Image 参考图用 `reference_image_urls`（1-16 张）+ quality 档位；
//      Nano Banana 参考图用 `image_urls`（最多 14 张，传入即改图模式）+ image_size（1K/2K/4K），
//      没有 quality 档（实测记录见随包 skill references/image-generation.md）。
//   2. 本插件的 prompt 是结构化 JSON 原文（用户在 skill 里组装），适配器只做长度闸门。
//   3. 轮询超时**不能重新提交**——那样会重复扣费，只能拿 task_id 去 `apiz tasks get` 取。
import { isHttpUrl, isDataUrl, MIME_MAP, assertImageInputPayloadSize, getDataUrlEncodedByteSize } from './shared.js'
import { uploadDataUrlToApiz } from './apizUpload.js'

export const DEFAULT_APIZ_BASE_URL = 'https://api.apiz.ai'
export const DEFAULT_APIZ_MODEL = 'apiz/gpt-image-2.5-flare'
export const DEFAULT_APIZ_QUALITY = 'low'

/** 质量档位（GPT-Image 家族；大小写不敏感；档位越高越贵，与分辨率无关）。 */
export const APIZ_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']
/** GPT-Image 比例白名单（10 种固定比例）。 */
export const APIZ_ASPECT_RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16']
/** Nano Banana 比例白名单（14 种，含超长比例）。 */
export const NB_ASPECT_RATIOS = [
  '1:4', '1:8', '4:1', '8:1', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1',
  '4:5', '3:4', '2:3', '9:16',
]
export const APIZ_MAX_REFERENCE_IMAGES = 16
export const NB_MAX_REFERENCE_IMAGES = 14
export const APIZ_MAX_PROMPT_CHARS = 7000
export const APIZ_SIZE_TIERS = ['1K', '2K', '4K']

const TERMINAL_OK = new Set(['completed', 'complete', 'success', 'succeeded', 'done'])
const TERMINAL_FAIL = new Set(['failed', 'fail', 'error', 'cancelled', 'canceled', 'timeout', 'expired'])

/** 模型家族：nano-banana → 'nb'，其余 → 'gpt-image'（默认路线）。 */
export function modelFamily(model) {
  return /nano[-_ ]?banana/i.test(String(model ?? '')) ? 'nb' : 'gpt-image'
}

export function maxReferenceImages(model) {
  return modelFamily(model) === 'nb' ? NB_MAX_REFERENCE_IMAGES : APIZ_MAX_REFERENCE_IMAGES
}

/** 比例合法性：按家族白名单校验；不在名单里报错（参数名传错/比例写错都会 400，先本地拦）。 */
export function normalizeAspectRatio(value, model) {
  const family = modelFamily(model)
  const whitelist = family === 'nb' ? NB_ASPECT_RATIOS : APIZ_ASPECT_RATIOS
  const text = String(value ?? '').trim()
  if (!text) return '1:1'
  if (!whitelist.includes(text)) {
    throw new Error(`不支持的比例 ${text}（${family === 'nb' ? 'Nano Banana' : 'GPT-Image'} 家族可用：${whitelist.join(' ')}）`)
  }
  return text
}

/** 质量归一化（仅 GPT-Image 家族消费；未知值回落默认档）。 */
export function normalizeApizQuality(value, fallback = DEFAULT_APIZ_QUALITY) {
  const text = String(value ?? '').trim().toLowerCase()
  if (APIZ_QUALITIES.includes(text)) return text
  if (text === 'standard' || text === 'sd') return 'medium'
  if (text === 'hd') return 'high'
  if (text === 'ultra' || text === 'best') return 'max'
  return APIZ_QUALITIES.includes(fallback) ? fallback : DEFAULT_APIZ_QUALITY
}

/** 提示词裁剪：超长直接截断（7000 字符硬上限），并回一条警告。 */
export function clampApizPrompt(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('apiz 生图需要非空 prompt')
  if (text.length <= APIZ_MAX_PROMPT_CHARS) return { prompt: text, warnings: [] }
  return {
    prompt: text.slice(0, APIZ_MAX_PROMPT_CHARS),
    warnings: [`Prompt ${text.length} 字符超过 apiz 上限 ${APIZ_MAX_PROMPT_CHARS}，已截断（JSON 末尾的字段可能被切掉，建议精简后再出图）`],
  }
}

/**
 * 组装 create 请求体（按模型家族）：
 *   GPT-Image：params = { prompt, quality, aspect_ratio, reference_image_urls }
 *   Nano Banana：params = { prompt, aspect_ratio, image_size, image_urls }
 * sizeTier 只在显式传 1K/2K/4K 时生效（GPT-Image 走 size 键、Nano Banana 走 image_size 键）。
 */
export function buildApizCreateBody(opts, referenceUrls = []) {
  const { prompt, warnings } = clampApizPrompt(opts.prompt)
  const family = modelFamily(opts.model)
  const model = String(opts.model ?? '').trim() || DEFAULT_APIZ_MODEL
  const params = { prompt }
  if (family === 'gpt-image') {
    params.quality = normalizeApizQuality(opts.quality)
    params.aspect_ratio = normalizeAspectRatio(opts.aspectRatio, model)
    if (referenceUrls.length) params.reference_image_urls = referenceUrls.slice(0, APIZ_MAX_REFERENCE_IMAGES)
  } else {
    params.aspect_ratio = normalizeAspectRatio(opts.aspectRatio, model)
    const tier = APIZ_SIZE_TIERS.includes(String(opts.sizeTier ?? '').toUpperCase()) ? String(opts.sizeTier).toUpperCase() : '1K'
    params.image_size = tier
    if (referenceUrls.length) params.image_urls = referenceUrls.slice(0, NB_MAX_REFERENCE_IMAGES)
  }
  return { body: { model, params }, family, warnings }
}

function apizUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_APIZ_BASE_URL
  return `${base}${path}`
}

async function postJson(url, apiKey, body, timeoutMs, getApiErrorMessage) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  return response.json()
}

function taskData(payload) {
  const data = payload?.data ?? payload
  if (!data || typeof data !== 'object') throw new Error(`apiz 返回了无法识别的任务体：${JSON.stringify(payload).slice(0, 400)}`)
  return data
}

export function collectImageUrls(data) {
  const buckets = [data?.result?.images, data?.output?.images, data?.images, data?.result?.output?.images]
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue
    const urls = bucket
      .map((item) => (typeof item === 'string' ? item : item?.url ?? item?.image_url))
      .filter((url) => isHttpUrl(url) || isDataUrl(url))
    if (urls.length) return urls
  }
  return []
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询任务直到终态。**超时不重投**（重投会重复扣费）。 */
export async function waitForApizTask(taskId, profile, getApiErrorMessage) {
  const queryUrl = apizUrl(profile.baseUrl, '/api/v3/tasks/query')
  const timeoutMs = profile.timeoutMs ?? 900_000
  const deadline = Date.now() + timeoutMs
  let interval = Math.max(500, profile.pollIntervalMs ?? 2000)
  let last = null
  while (Date.now() < deadline) {
    const payload = await postJson(queryUrl, profile.apiKey, { task_id: taskId }, Math.max(30_000, Math.min(120_000, timeoutMs)), getApiErrorMessage)
    const data = taskData(payload)
    const status = String(data.status ?? '').toLowerCase()
    last = data
    if (TERMINAL_OK.has(status)) return data
    if (TERMINAL_FAIL.has(status)) {
      const detail = data.error ?? data.detail ?? data.message ?? JSON.stringify(data).slice(0, 400)
      throw new Error(`apiz 任务失败（status=${status}）：${typeof detail === 'string' ? detail : JSON.stringify(detail)}（task_id=${taskId}，失败任务整笔退还）`)
    }
    await sleep(interval)
    interval = Math.min(Math.round(interval * 1.25), 5000)
  }
  throw new Error(
    `apiz 任务轮询超时（${Math.round(timeoutMs / 1000)} 秒，task_id=${taskId}）。` +
    `任务可能仍在进行且已预扣积分：**不要重新提交**，稍后用 \`apiz tasks get ${taskId}\` 取结果，或调大插件设置里的 timeoutSeconds。` +
    (last ? `最后状态：${String(last.status ?? 'unknown')}` : ''),
  )
}

/**
 * 参考图解析：http(s) URL 直接透传；data URL / 本地文件路径先传到 apiz CDN 换公网 URL。
 * 本地路径由调用方读成 data URL 再进来（generate.js 统一做，便于测试注入）。
 */
export async function resolveApizReferenceUrls(inputs, options = {}) {
  const list = Array.isArray(inputs) ? inputs.filter(Boolean) : []
  if (!list.length) return []
  assertImageInputPayloadSize(list.reduce((sum, item) => sum + getDataUrlEncodedByteSize(item), 0))
  const limit = maxReferenceImages(options.model)

  const urls = []
  for (const item of list) {
    if (urls.length >= limit) break
    if (isHttpUrl(item)) urls.push(String(item))
    else if (isDataUrl(item)) urls.push(await uploadDataUrlToApiz(item, options))
    else throw new Error('参考图只接受 http(s) URL 或本地图片路径（内部已转 data URL）')
  }
  if (list.length > limit) {
    options.onTrim?.(list.length, limit)
  }
  return urls
}

/**
 * 完整生图链路：参考图解析 → create → 轮询 → 取成图 URL。
 * 返回 { imageUrls, taskId, price, family, params, warnings }；下载落盘由调用方做。
 */
export async function callApizImageApi(opts, profile) {
  const apiKey = String(profile.apiKey ?? '').trim()
  if (!apiKey) {
    throw new Error('apiz 生图需要 API Key：插件设置填 apizApiKey，或设置环境变量 APIZ_API_KEY，或本机 `apiz auth login` 后开启插件设置 apizUseCliAuth。没有 HTTP 通道时也可以直接用 apiz CLI 出图（命令见随包 skill references/image-generation.md）')
  }

  const model = String(opts.model ?? '').trim() || DEFAULT_APIZ_MODEL
  const referenceUrls = await resolveApizReferenceUrls(opts.inputImages ?? [], { ...profile.uploadOptions, model })
  const { body, family, warnings } = buildApizCreateBody({ ...opts, model }, referenceUrls)

  const created = await postJson(
    apizUrl(profile.baseUrl, '/api/v3/tasks/create'),
    apiKey,
    body,
    Math.max(30_000, Math.min(120_000, profile.timeoutMs ?? 900_000)),
    opts.getApiErrorMessage,
  )
  const task = taskData(created)
  const taskId = String(task.task_id ?? task.id ?? '')
  if (!taskId) throw new Error(`apiz 没有返回 task_id：${JSON.stringify(created).slice(0, 400)}`)

  const finished = await waitForApizTask(taskId, profile, opts.getApiErrorMessage)
  const imageUrls = collectImageUrls(finished)
  if (!imageUrls.length) {
    throw new Error(`apiz 任务完成但没有图片 URL（task_id=${taskId}）：${JSON.stringify(finished.result ?? finished.output ?? finished).slice(0, 400)}`)
  }

  return {
    imageUrls,
    taskId,
    family,
    params: { ...body.params, prompt: `${body.params.prompt.slice(0, 80)}…` },
    price: typeof task.price === 'number' ? task.price : null,
    warnings,
  }
}
