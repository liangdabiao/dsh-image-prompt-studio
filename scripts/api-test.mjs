// api 路由冒烟：把 registerApi 的 handler 包成真实 http server，逐条路由真实 fetch。
// 运行：node scripts/api-test.mjs （出图任务用未配置 key 的失败路径，不花钱）
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ips-api-'))

const { registerApi } = await import('../lib/api.js')
const { TOOLS } = await import('../lib/tools.js')

// 最小宿主 ctx：capture prefix handler；无 connection 服务 → fail-open（与沙盒一致）
let handler = null
const ctx = {
  webServer: { register: (opts) => { handler = opts.handler } },
  get: () => null,
}
await registerApi(ctx)
assert.ok(handler, 'registerApi 没有注册 handler')

const server = createServer((req, res) => { handler(req, res).catch((err) => { res.writeHead(500); res.end(String(err)) }) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/image-prompt-studio`

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (err) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(err)
  }
}
const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

await test('GET /api/ping → ok + version', async () => {
  const r = await get('/api/ping')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(r.body.version)
})

await test('GET /api/status → 数据目录 / apiz 未配置 / 统计', async () => {
  const r = await get('/api/status')
  assert.equal(r.body.ok, true)
  assert.equal(r.body.auth.configured, false)
  assert.match(r.body.imagesDir, /image-prompt-studio/)
  assert.ok('stats' in r.body)
})

await test('GET /api/presets → 内置 9 套；GET /api/preset 取到完整 JSON', async () => {
  const list = await get('/api/presets')
  assert.ok(list.body.presets.length >= 9)
  const one = await get(`/api/preset?name=${encodeURIComponent('三国')}`)
  assert.equal(one.body.ok, true)
  assert.ok(one.body.data['风格模式'])
  const missing = await get('/api/preset?name=ghost')
  assert.equal(missing.status, 404)
})

await test('POST /api/validate → 通过/失败/解析错误 三种回执', async () => {
  const good = await post('/api/validate', { prompt: JSON.stringify({ 风格模式: 'x', 场景: {}, 相机: {}, 审美控制: {} }) })
  assert.equal(good.body.ok, true)
  assert.equal(good.body.report.passed, false, '只有四个顶层字段应报缺')
  const partial = await post('/api/validate', { prompt: JSON.stringify({ 场景: { 主体: {} } }), partial: true })
  assert.equal(partial.body.report.passed, true)
  const broken = await post('/api/validate', { prompt: 'not json' })
  assert.equal(broken.body.ok, false)
  assert.match(broken.body.error, /JSON 解析失败/)
})

await test('POST /api/diff → 冻结率与改动清单', async () => {
  const doc = JSON.stringify({ a: '1', b: { c: '2' } })
  const same = await post('/api/diff', { before: doc, after: doc })
  assert.equal(same.body.diff.frozenRate, 100)
  const changed = await post('/api/diff', { before: doc, after: JSON.stringify({ a: '1', b: { c: '3' } }) })
  assert.equal(changed.body.diff.changed.length, 1)
  assert.equal(changed.body.diff.changed[0].path, 'b.c')
})

await test('预设存取：POST /api/presets 保存 → GET 可读 → /api/preset/remove 删除', async () => {
  const saved = await post('/api/presets', { name: 'api测试预设', data: { 风格模式: '测试' } })
  assert.equal(saved.body.ok, true)
  const got = await get(`/api/preset?name=${encodeURIComponent('api测试预设')}`)
  assert.equal(got.body.ok, true)
  const removed = await post('/api/preset/remove', { name: 'api测试预设' })
  assert.equal(removed.body.ok, true)
})

await test('POST /api/generate（未配置 key）→ job 异步失败并给出兜底指引', async () => {
  const r = await post('/api/generate', { prompt: { 风格模式: 'x' }, model: 'apiz/gpt-image-2.5-flare' })
  assert.equal(r.body.ok, true)
  assert.ok(r.body.job)
  let job = null
  for (let i = 0; i < 20; i += 1) {
    const jr = await get(`/api/job?id=${encodeURIComponent(r.body.job)}`)
    job = jr.body.job
    if (job.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(job.status, 'failed')
  assert.match(job.error, /apizApiKey|apiz CLI/)
})

await test('POST /api/generate 缺 prompt → 400', async () => {
  const r = await post('/api/generate', {})
  assert.equal(r.status, 400)
})

await test('GET /api/history + remove + clear', async () => {
  const list = await get('/api/history')
  assert.equal(list.body.ok, true)
  assert.equal(list.body.total, 0)
  const removed = await post('/api/history/remove', { id: 'ghost' })
  assert.equal(removed.status, 404)
  const cleared = await post('/api/history/clear', {})
  assert.equal(cleared.body.ok, true)
})

await test('GET /media → 目录约束（外部路径 403 / 404）', async () => {
  const outside = await fetch(`${base}/media?path=${encodeURIComponent(join(tmpdir(), 'outside.jpg'))}`)
  assert.equal(outside.status, 404)
})

await test('静态页：/ 返回工作台 index.html；未知 api 404；未知静态 404', async () => {
  const home = await fetch(`${base}/`)
  assert.equal(home.status, 200)
  assert.match(home.headers.get('content-type'), /text\/html/)
  const html = await home.text()
  assert.match(html, /提示词工作台/)
  const notFound = await get('/api/ghost')
  assert.equal(notFound.status, 404)
  const staticMiss = await fetch(`${base}/no-such-file.js`)
  assert.equal(staticMiss.status, 404)
})

await test('风格槽路由：upload 落盘 → set 写回 → get 可读 → clear 清空；media 放行 uploads', async () => {
  const up = await post('/api/style/upload', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'style.png' })
  assert.equal(up.body.ok, true)
  assert.match(up.body.file, /uploads/)
  const badSet = await post('/api/style', { prompt: { 风格模式: 'x' } })
  assert.equal(badSet.status, 400, '缺 referenceImage 应 400')
  const set = await post('/api/style', { prompt: { 风格模式: '测试' }, referenceImage: up.body.file, note: '自检风格' })
  assert.equal(set.body.ok, true)
  const got = await get('/api/style')
  assert.equal(got.body.style.referenceImage, up.body.file)
  // media 现在应能读 uploads 里的参考图（风格卡缩略图依赖它）
  const media = await fetch(`${base}/media?path=${encodeURIComponent(up.body.file)}`)
  assert.equal(media.status, 200)
  const cleared = await post('/api/style/clear', {})
  assert.equal(cleared.body.ok, true)
  const gotEmpty = await get('/api/style')
  assert.equal(gotEmpty.body.style, null)
})

await test('六个工具全部可从 api 侧取到（同引擎）', async () => {
  assert.equal(TOOLS.length, 6)
})

server.close()
console.log(`\n${failed ? '存在失败' : '全部通过'}：${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
