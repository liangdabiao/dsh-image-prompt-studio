// 生图适配器共享工具（Node 版；移植自 dsh-ecom-visual-copy/lib/image/shared.js）
export const MIME_MAP = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

export const MAX_IMAGE_INPUT_BYTES = 512 * 1024 * 1024

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value)
}

export function getDataUrlEncodedByteSize(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return 0
  const base64 = dataUrl.slice(commaIndex + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function assertImageInputPayloadSize(totalBytes) {
  if (totalBytes > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`参考图总负载 ${(totalBytes / 1024 / 1024).toFixed(1)} MB 超过上限，请减少或压缩参考图`)
  }
}

export function dataUrlToBuffer(dataUrl) {
  const commaIndex = dataUrl.indexOf(',')
  return Buffer.from(dataUrl.slice(commaIndex + 1), 'base64')
}

/** 下载成图到 Buffer（mime 跟随响应头，回落默认）。 */
export async function fetchImageBuffer(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`成图下载失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const mime = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg'
  return { buffer, mime }
}
