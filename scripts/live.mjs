// 真实出图验证：走 runGenerate 完整链路（参考图上传 CDN → create → 轮询 → 下载落盘 → 历史）。
// 消耗：GPT-Image flare low 档 10 积分/张（0.1 元）。key 从本机 apiz CLI 登录态解析（不写进任何文件）。
// 运行：node scripts/live.mjs [参考图路径]
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ref = process.argv[2] || resolve(ROOT, '../资料/image-prompt-studio-main/assets/examples/01-reference.jpg')

const { runGenerate } = await import('../lib/generate.js')
const { resolveApizApiKey, readApizCliApiKey } = await import('../lib/image/apizUpload.js')

// key 解析：显式环境变量 > CLI 登录态（live 验证允许直接复用 CLI 登录态，不进插件配置）
const auth = resolveApizApiKey(process.env.APIZ_API_KEY ?? '', { allowCliAuth: true })
if (!auth.key) {
  console.error('没有可用的 apiz key：先 `apiz auth login` 或设 APIZ_API_KEY')
  process.exit(2)
}
console.log(`key source: ${auth.source}（CLI 登录态可读：${Boolean(readApizCliApiKey())}）`)

// 提示词用上游 README 示例 1 的产物（本就是从这张参考图反推的——正好验证「参考图必须传回」铁律）
const promptText = readFileSync(resolve(ROOT, '../资料/image-prompt-studio-main/assets/examples/prompt.json'), 'utf8')

console.log('提交生图（apiz/gpt-image-2.5-flare, low, 1:1, 带参考图）…')
const started = Date.now()
try {
  const { record, files, result } = await runGenerate(
    { prompt: promptText, model: 'apiz/gpt-image-2.5-flare', quality: 'low', aspectRatio: '1:1', referenceImages: [ref] },
    { apizApiKey: auth.key, apizBaseUrl: 'https://api.apiz.ai', timeoutSeconds: 900, apizBin: process.env.APIZ_BIN },
  )
  console.log(`✅ 完成（${Math.round(record.durationMs / 1000)}s，${record.price} 积分，参考图 ${record.referenceCount} 张）`)
  console.log(`taskId: ${result.taskId}`)
  console.log(`成图: ${files.join('\n      ')}`)
} catch (err) {
  console.error(`❌ ${String(err.message || err)}`)
  process.exit(1)
}
console.log(`总耗时 ${Math.round((Date.now() - started) / 1000)}s`)
