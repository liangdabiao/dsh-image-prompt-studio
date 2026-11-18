// 生图执行编排：prompt 组装（JSON 原文 + 特别要求）→ 参考图解析（本地图读成 data URL / http 直传）
// → apiz HTTP 生图（lib/image/apiz.js）→ 成图下载落盘 → 生成历史存证。
// 超时不重提交（重复扣费红线）；参考图铁律在 skill 里执行，这里只透传。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { callApizImageApi, modelFamily, DEFAULT_APIZ_MODEL } from './image/apiz.js'
import { resolveApizApiKey } from './image/apizUpload.js'
import { fetchImageBuffer } from './image/shared.js'
import { DATA_DIR, IMAGES_DIR, ensureDirs, addHistoryRecord } from './data.js'
import { parsePrompt } from './check.js'

const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

/** 单个参考图输入 → http URL 或 data URL（本地图读文件转 data URL，由 apizUpload 传 CDN）。 */
export function normalizeReferenceInput(input) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('参考图不能为空字符串')
  if (/^https?:\/\//i.test(value)) return value
  if (/^data:image\//i.test(value)) return value
  if (!isAbsolute(value)) throw new Error(`参考图本地路径必须是绝对路径：${value}`)
  if (!existsSync(value)) throw new Error(`参考图文件不存在：${value}`)
  const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
  const mime = mimeByExt[extname(value).toLowerCase()]
  if (!mime) throw new Error(`参考图只支持 png/jpg/webp/gif：${value}`)
  return `data:${mime};base64,${readFileSync(value).toString('base64')}`
}

/** prompt 组装：JSON 原文在前；特别要求以「\n\n特别要求：」追加（与 skill 路径 C 约定一致）。 */
export function assemblePrompt(promptText, extraRequirements) {
  // prompt 允许直接传对象（结构化 JSON），统一序列化为带缩进的中文原文
  const base = typeof promptText === 'object' && promptText !== null
    ? JSON.stringify(promptText, null, 2)
    : String(promptText ?? '').trim()
  if (!base) throw new Error('prompt 不能为空（传结构化 JSON 提示词的原文）')
  const extra = String(extraRequirements ?? '').trim()
  // 对象输入先过一遍解析（提前暴露非法 JSON；字符串输入可能是 CLI 兜底场景的手写文本，不强校验）
  if (typeof promptText === 'object') parsePrompt(promptText)
  return extra ? `${base}\n\n特别要求：${extra}` : base
}

/**
 * 完整生图：返回 { ok, summary, data } 形态的记录对象（工具层直接包成工具输出）。
 * opts: { prompt, extraRequirements, model, quality, aspectRatio, sizeTier, referenceImages }
 */
export async function runGenerate(opts, config) {
  const model = String(opts.model ?? config.defaultModel ?? '').trim() || DEFAULT_APIZ_MODEL
  const quality = String(opts.quality ?? config.quality ?? 'low')
  const aspectRatio = String(opts.aspectRatio ?? '1:1')
  const sizeTier = String(opts.sizeTier ?? '')
  const referenceInputs = Array.isArray(opts.referenceImages) ? opts.referenceImages : []

  const prompt = assemblePrompt(opts.prompt, opts.extraRequirements)

  // 参考：http 直传；本地图读成 data URL
  const inputImages = []
  for (const item of referenceInputs) inputImages.push(normalizeReferenceInput(item))

  const auth = resolveApizApiKey(config.apizApiKey, { allowCliAuth: config.apizUseCliAuth === true })
  if (!auth.key) {
    throw new Error('apiz HTTP 生图未配置：插件设置填 apizApiKey（或环境变量 APIZ_API_KEY，或本机 `apiz auth login` + 开启 apizUseCliAuth）。也可以直接用 apiz CLI 出图（命令见随包 skill references/image-generation.md），出图后把路径告诉用户。')
  }

  const profile = {
    baseUrl: String(config.apizBaseUrl ?? '').trim() || undefined,
    apiKey: auth.key,
    timeoutMs: Math.max(60_000, (Number(config.timeoutSeconds) || 900) * 1000),
    pollIntervalMs: Number(config.pollIntervalMs) || undefined, // 测试注入用；生产走适配器默认
    uploadOptions: { bin: config.apizBin },
  }

  const startedAt = Date.now()
  const result = await callApizImageApi(
    {
      prompt,
      model,
      quality,
      aspectRatio,
      sizeTier,
      inputImages,
      getApiErrorMessage: async (response) => {
        let detail = ''
        try { detail = (await response.text()).slice(0, 400) } catch { /* 忽略读体失败 */ }
        return `apiz HTTP ${response.status}：${detail}`
      },
    },
    profile,
  )

  // 成图落盘（返回的所有 URL 都下载，命名带时间戳）
  ensureDirs()
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const files = []
  for (let index = 0; index < result.imageUrls.length; index += 1) {
    const { buffer, mime } = await fetchImageBuffer(result.imageUrls[index])
    const file = join(IMAGES_DIR, `${stamp}-${result.taskId.slice(-6)}-${index + 1}${EXT_BY_MIME[mime] ?? '.jpg'}`)
    writeFileSync(file, buffer)
    files.push(file)
  }

  const record = addHistoryRecord({
    ok: true,
    model: result.family === 'nb' ? `${model}（Nano Banana 路线）` : `${model}（GPT-Image 路线）`,
    family: result.family,
    aspectRatio,
    quality: result.family === 'gpt-image' ? quality : null,
    sizeTier: result.family === 'nb' ? (sizeTier || '1K') : null,
    referenceCount: inputImages.length,
    taskId: result.taskId,
    price: result.price,
    durationMs: Date.now() - startedAt,
    authSource: auth.source,
    warnings: result.warnings,
    files,
    promptPreview: prompt.slice(0, 200),
    promptChars: prompt.length,
  })

  return { record, files, result }
}

export { DATA_DIR, IMAGES_DIR }
