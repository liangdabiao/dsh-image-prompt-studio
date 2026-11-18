// 数据层 / 机械校验内核 / apiz 适配器单测（离线，零依赖，网络全部 mock）。
// 运行：node test/lib.test.mjs （Windows 下比 node --test 更稳，无 async 资源误报）
// 另有一组「金标准」用例：随包 skill 的 9 套内置预设，校验器不应对完整预设报 error；
// 若本机有 python，还会与上游 validate_prompt.py 做行为对齐（JS 通过 ⇔ Python 通过）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ips-test-'))

const { parsePrompt, validatePrompt, diffPrompts, flattenLeaves, getByPath } = await import('../lib/check.js')
const { listPresets, getPreset, savePreset, deletePreset, readHistory, addHistoryRecord, removeRecord, clearHistory, summarizeHistory } = await import('../lib/data.js')
const { buildApizCreateBody, callApizImageApi, waitForApizTask, clampApizPrompt, normalizeAspectRatio, normalizeApizQuality, modelFamily, maxReferenceImages, DEFAULT_APIZ_MODEL } = await import('../lib/image/apiz.js')
const { resolveApizApiKey, readApizCliApiKey } = await import('../lib/image/apizUpload.js')
const { normalizeReferenceInput, assemblePrompt, runGenerate, IMAGES_DIR } = await import('../lib/generate.js')

const PRESETS_DIR = fileURLToPath(new URL('../skills/image-prompt-studio/assets/presets/', import.meta.url))

// ---------------------------------------------------------------- 测试骨架（同步立即跑；async 用例收尾统一跑）

let passed = 0
let failed = 0
const asyncTests = []
const test = (name, fn) => {
  if (fn.constructor.name === 'AsyncFunction') {
    // async 用例不在注册时启动（会并发抢同一个 globalThis.fetch mock），收尾串行跑
    asyncTests.push([name, fn])
    return
  }
  try {
    fn()
  } catch (err) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(err)
    return
  }
  passed += 1
  console.log(`✓ ${name}`)
}

const finish = async () => {
  for (const [name, fn] of asyncTests) {
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
  console.log(`\n${failed ? '存在失败' : '全部通过'}：${passed} 通过 / ${failed} 失败`)
  process.exit(failed ? 1 : 0)
}

// ---------------------------------------------------------------- check.js · 结构校验

test('getByPath：嵌套取值与缺席', () => {
  const [ok1, v1] = getByPath({ a: { b: { c: 'x' } } }, 'a.b.c')
  assert.equal(ok1, true)
  assert.equal(v1, 'x')
  const [ok2] = getByPath({ a: 1 }, 'a.b')
  assert.equal(ok2, false)
})

test('parsePrompt：对象透传 / 字符串解析 / ```json 围栏剥离', () => {
  const obj = { 风格模式: 'x' }
  assert.equal(parsePrompt(obj), obj)
  assert.deepEqual(parsePrompt('{"风格模式":"y"}'), { 风格模式: 'y' })
  assert.deepEqual(parsePrompt('```json\n{"风格模式":"z"}\n```'), { 风格模式: 'z' })
  assert.throws(() => parsePrompt(''), /提示词为空/)
  assert.throws(() => parsePrompt('不是 json'), /JSON 解析失败/)
})

test('validatePrompt：金标准——内置预设部分模式全通过；完整结构预设零 error', () => {
  // 已知例外：雪景下的中秋星野 少「外形特征.眼睛」（27 叶），完整模式与上游 python 同样报缺字段
  const knownPartial = new Set(['中秋星野（仅角色）.json', '雪景下的中秋星野.json'])
  for (const file of readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'))) {
    const data = parsePrompt(readFileSync(join(PRESETS_DIR, file), 'utf8'))
    assert.equal(validatePrompt(data, { partial: true }).passed, true, `${file} 部分模式应通过`)
    if (knownPartial.has(file)) continue
    const report = validatePrompt(data)
    assert.deepEqual(report.errors, [], `${file} 不应有 error：${report.errors.join('; ')}`)
  }
})

test('validatePrompt：完整模式缺字段逐条列出', () => {
  const report = validatePrompt({ 风格模式: 'x' })
  assert.equal(report.passed, false)
  assert.ok(report.errors.some((e) => e.includes('缺少顶层字段: 场景')))
  assert.ok(report.errors.some((e) => e.includes('缺少字段: 场景.主体.整体描述')))
})

test('validatePrompt：部分模式只提示不拦', () => {
  const report = validatePrompt({ 风格模式: 'x' }, { partial: true })
  assert.equal(report.passed, true)
  assert.ok(report.warnings.length > 0)
  assert.equal(report.errors.length, 0)
})

test('validatePrompt：类型红线（材质真实度必须非空字符串数组；嵌套拍平报错；空值报错）', () => {
  const base = JSON.parse(readFileSync(join(PRESETS_DIR, '海边中秋星野.json'), 'utf8'))
  const materialAsString = structuredClone(base)
  materialAsString['审美控制']['材质真实度'] = '一条字符串'
  assert.ok(validatePrompt(materialAsString).errors.some((e) => e.includes('材质真实度 应为数组')))

  const emptyArray = structuredClone(base)
  emptyArray['审美控制']['材质真实度'] = []
  assert.ok(validatePrompt(emptyArray).errors.some((e) => e.includes('至少需要 1 条')))

  const emptyItem = structuredClone(base)
  emptyItem['审美控制']['材质真实度'] = ['ok', '  ']
  assert.ok(validatePrompt(emptyItem).errors.some((e) => e.includes('空串或非字符串元素')))

  const flattened = structuredClone(base)
  flattened['场景'] = '拍平成字符串'
  assert.ok(validatePrompt(flattened).errors.some((e) => e.includes('场景 应为对象')))

  const emptyValue = structuredClone(base)
  emptyValue['画面气质'] = '   '
  assert.ok(validatePrompt(emptyValue).errors.some((e) => e.includes('空值: 画面气质')))
})

test('validatePrompt：与上游 validate_prompt.py 行为对齐（本机有 python 时）', () => {
  const pyScript = fileURLToPath(new URL('../skills/image-prompt-studio/scripts/validate_prompt.py', import.meta.url))
  let python = null
  for (const bin of ['python', 'py']) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); python = bin; break } catch { /* 下一个 */ }
  }
  if (!python) {
    console.log('  （本机无 python，跳过对齐用例）')
    return
  }
  // 正例：完整预设，Python 退出码 0
  const good = join(PRESETS_DIR, '海边中秋星野.json')
  execFileSync(python, [pyScript, good], { stdio: 'ignore' })
  assert.equal(validatePrompt(parsePrompt(readFileSync(good, 'utf8'))).passed, true)

  // 反例：材质真实度写成字符串，两边都判失败（Python 退出码 1）
  const bad = structuredClone(parsePrompt(readFileSync(good, 'utf8')))
  bad['审美控制']['材质真实度'] = 'oops'
  const badFile = join(tmpdir(), `ips-bad-${Date.now()}.json`)
  writeFileSync(badFile, JSON.stringify(bad, null, 2))
  let pyFailed = false
  try { execFileSync(python, [pyScript, badFile], { stdio: 'ignore' }) } catch { pyFailed = true }
  assert.equal(pyFailed, true, 'python 校验应失败')
  assert.equal(validatePrompt(bad).passed, false, 'JS 校验应同步失败')
})

// ---------------------------------------------------------------- check.js · 冻结度比对

test('diffPrompts：README 金标准语义（改 11 个叶子字段 → 28 叶 / 冻结率 61%）', () => {
  const before = parsePrompt(readFileSync(join(PRESETS_DIR, '海边中秋星野.json'), 'utf8'))
  const after = structuredClone(before)
  const sub = after['场景']['主体']
  sub['整体描述'] = '改后的主体'
  sub['外形特征']['面部'] = '改后的面部'
  sub['外形特征']['头发'] = '改后的头发'
  sub['外形特征']['眼睛'] = '改后的眼睛'
  sub['表情与动作']['情绪'] = '改后的情绪'
  sub['表情与动作']['动作'] = '改后的动作'
  sub['服装']['穿着'] = '改后的穿着'
  sub['服装']['细节'] = '改后的细节'
  sub['配饰'] = '改后的配饰'
  after['场景']['环境']['地点设定'] = '改后的地点'
  after['相机']['机位角度'] = '改后的机位'
  const diff = diffPrompts(before, after)
  // 上游 README 示例是 26 叶（58%）；内置「海边中秋星野」预设多两个字段，28 叶 / 11 改 / 17 冻结
  assert.equal(diff.totalLeaves, 28)
  assert.equal(diff.changed.length, 11)
  assert.equal(diff.frozen.length, 17)
  assert.equal(diff.frozenRate, 61)
  for (const c of diff.changed) {
    assert.match(c.path, /^场景\.主体\.|^场景\.环境\.地点设定$|^相机\.机位角度$/)
  }
  assert.ok(diff.frozen.includes('风格模式'))
  assert.ok(diff.frozen.includes('审美控制.色彩风格.整体色调'))
})

test('diffPrompts：完全一致 → 冻结率 100%；新增/删除字段单列', () => {
  const doc = { a: '1', b: { c: '2' } }
  const same = diffPrompts(doc, structuredClone(doc))
  assert.equal(same.changed.length, 0)
  assert.equal(same.frozen.length, 2)
  assert.equal(same.frozenRate, 100)

  const withAdd = diffPrompts(doc, { a: '1', b: { c: '2', d: '3' }, e: '4' })
  assert.deepEqual(withAdd.added, ['b.d', 'e'])
  const withRemoved = diffPrompts(doc, { a: '1' })
  assert.deepEqual(withRemoved.removed, ['b.c'])
})

test('flattenLeaves：数组展开 / 空容器序列化', () => {
  const leaves = flattenLeaves({ list: ['x', 'y'], empty: [], obj: {} })
  assert.equal(leaves.get('list.0'), 'x')
  assert.equal(leaves.get('list.1'), 'y')
  assert.equal(leaves.get('empty'), '[]')
  assert.equal(leaves.get('obj'), '{}')
})

// ---------------------------------------------------------------- data.js · 预设库

test('listPresets：内置 9 套全部可见（含部分结构预设）', () => {
  const presets = listPresets()
  assert.equal(presets.filter((p) => p.builtin).length, 9)
  const partial = presets.filter((p) => p.partial)
  assert.equal(partial.length, 1)
  assert.equal(partial[0].name, '中秋星野（仅角色）')
})

test('getPreset：按名取内置；用户同名优先；不存在返回 null', () => {
  const builtin = getPreset('三国')
  assert.ok(builtin.builtin)
  assert.ok(builtin.data['风格模式'])
  assert.equal(getPreset('不存在的预设'), null)
  savePreset('三国', { 风格模式: '我的版本' })
  const overridden = getPreset('三国')
  assert.equal(overridden.builtin, false)
  assert.equal(overridden.data['风格模式'], '我的版本')
  deletePreset('三国')
  assert.equal(getPreset('三国').builtin, true)
})

test('savePreset：内置只读拒绝；deletePreset 只删用户侧', () => {
  assert.throws(() => savePreset('宋代', {}, { builtin: true }), /内置预设只读/)
  savePreset('临时预设', { a: 1 })
  assert.equal(deletePreset('临时预设'), true)
  assert.equal(deletePreset('临时预设'), false)
  assert.equal(deletePreset('三国'), false, '内置不可删')
})

// ---------------------------------------------------------------- data.js · 生成历史

test('history：add/remove/clear/summarize', () => {
  clearHistory()
  const rec = addHistoryRecord({ ok: true, model: 'apiz/gpt-image-2.5-flare', price: 10, durationMs: 61_000, files: ['/x/a.jpg'], referenceCount: 1 })
  addHistoryRecord({ ok: false, model: 'x', error: 'boom' })
  const all = readHistory()
  assert.equal(all.length, 2)
  assert.ok(all[0].id.startsWith('gen-'))
  const stats = summarizeHistory(all)
  assert.deepEqual([stats.total, stats.ok, stats.failed, stats.credits], [2, 1, 1, 10])
  assert.equal(removeRecord(rec.id), true)
  assert.equal(removeRecord(rec.id), false)
  assert.equal(clearHistory(), 1)
  assert.equal(readHistory().length, 0)
})

// ---------------------------------------------------------------- image/apiz.js · 参数组装

test('modelFamily：nano-banana → nb，其余 → gpt-image', () => {
  assert.equal(modelFamily('service-inference/gemini-nano-banana-2.1'), 'nb')
  assert.equal(modelFamily('fal-ai/nano-banana-pro'), 'nb')
  assert.equal(modelFamily('apiz/gpt-image-2.5-flare'), 'gpt-image')
  assert.equal(modelFamily(''), 'gpt-image')
  assert.equal(maxReferenceImages('service-inference/gemini-nano-banana-2.1'), 14)
  assert.equal(maxReferenceImages('apiz/gpt-image-2.5-flare'), 16)
})

test('normalizeAspectRatio：双家族白名单，越界报错（本地拦截，避免 400）', () => {
  assert.equal(normalizeAspectRatio('3:4', 'apiz/gpt-image-2.5-flare'), '3:4')
  assert.equal(normalizeAspectRatio('', 'apiz/gpt-image-2.5-flare'), '1:1')
  assert.equal(normalizeAspectRatio('1:8', 'service-inference/gemini-nano-banana-2.1'), '1:8')
  assert.throws(() => normalizeAspectRatio('1:8', 'apiz/gpt-image-2.5-flare'), /不支持的比例 1:8/)
  assert.throws(() => normalizeAspectRatio('7:3', 'service-inference/gemini-nano-banana-2.1'), /不支持的比例 7:3/)
})

test('normalizeApizQuality：档位归一化，未知回落默认 low', () => {
  assert.equal(normalizeApizQuality('HIGH'), 'high')
  assert.equal(normalizeApizQuality('hd'), 'high')
  assert.equal(normalizeApizQuality('standard'), 'medium')
  assert.equal(normalizeApizQuality('whatever'), 'low')
})

test('clampApizPrompt：空报错；超长截断并带警告', () => {
  assert.throws(() => clampApizPrompt('  '), /非空 prompt/)
  const { prompt, warnings } = clampApizPrompt('x'.repeat(7500))
  assert.equal(prompt.length, 7000)
  assert.equal(warnings.length, 1)
})

test('buildApizCreateBody：GPT-Image 走 quality + reference_image_urls；Nano Banana 走 image_size + image_urls', () => {
  const gpt = buildApizCreateBody(
    { prompt: 'P', model: 'apiz/gpt-image-2.5-flare', quality: 'low', aspectRatio: '1:1' },
    ['https://a/1.jpg'],
  )
  assert.equal(gpt.family, 'gpt-image')
  assert.equal(gpt.body.model, 'apiz/gpt-image-2.5-flare')
  assert.equal(gpt.body.params.quality, 'low')
  assert.deepEqual(gpt.body.params.reference_image_urls, ['https://a/1.jpg'])
  assert.ok(!('image_urls' in gpt.body.params))
  assert.ok(!('image_size' in gpt.body.params))

  const nb = buildApizCreateBody(
    { prompt: 'P', model: 'service-inference/gemini-nano-banana-2.1', aspectRatio: '1:1', sizeTier: '2K' },
    ['https://a/1.jpg', 'https://a/2.jpg'],
  )
  assert.equal(nb.family, 'nb')
  assert.equal(nb.body.params.image_size, '2K')
  assert.deepEqual(nb.body.params.image_urls, ['https://a/1.jpg', 'https://a/2.jpg'])
  assert.ok(!('reference_image_urls' in nb.body.params))
  assert.ok(!('quality' in nb.body.params))

  // 参考图上限裁剪 + 默认模型
  const trimmed = buildApizCreateBody({ prompt: 'P', model: 'apiz/gpt-image-2.5-flare' }, Array.from({ length: 20 }, (_, i) => `https://a/${i}.jpg`))
  assert.equal(trimmed.body.params.reference_image_urls.length, 16)
  assert.equal(buildApizCreateBody({ prompt: 'P' }).body.model, DEFAULT_APIZ_MODEL)
})

test('resolveApizApiKey：配置 > 环境变量 > CLI 登录态（默认不自动复用）', () => {
  assert.deepEqual(resolveApizApiKey('k1'), { key: 'k1', source: 'config' })
  const prevEnv = process.env.APIZ_API_KEY
  delete process.env.APIZ_API_KEY
  assert.deepEqual(resolveApizApiKey(''), { key: '', source: 'none' })
  process.env.APIZ_API_KEY = 'k-env'
  assert.deepEqual(resolveApizApiKey(''), { key: 'k-env', source: 'env' })
  delete process.env.APIZ_API_KEY
  assert.deepEqual(resolveApizApiKey('', { allowCliAuth: false }), { key: '', source: 'none' })
  // CLI 登录态：APIZ_CONFIG 显式指定（隔离环境不会读用户真实登录态）
  const cfg = join(tmpdir(), `ips-apiz-${Date.now()}.toml`)
  writeFileSync(cfg, 'api_key = "k-cli"\n')
  process.env.APIZ_CONFIG = cfg
  assert.equal(readApizCliApiKey(), 'k-cli')
  assert.deepEqual(resolveApizApiKey('', { allowCliAuth: true }), { key: 'k-cli', source: 'apiz-cli' })
  delete process.env.APIZ_CONFIG
  if (prevEnv !== undefined) process.env.APIZ_API_KEY = prevEnv
})

// ---------------------------------------------------------------- image/apiz.js · 任务链路（mock fetch）

/** mock apiz HTTP：create → query（pending 次数可配）→ 图片下载。 */
function mockApizFetch({ pendingQueries = 0, finalStatus = 'completed', images = ['https://img/a.jpg'] } = {}) {
  const calls = []
  const realFetch = globalThis.fetch
  let queries = 0
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const urlText = String(url)
    if (urlText.endsWith('/api/v3/tasks/create')) {
      return jsonResponse(200, { data: { task_id: 'task-x1', price: 10 } })
    }
    if (urlText.endsWith('/api/v3/tasks/query')) {
      queries += 1
      const status = queries <= pendingQueries ? 'running' : finalStatus
      const payload = status === 'completed'
        ? { data: { status, result: { images: images.map((u) => ({ url: u })) }, price: 10 } }
        : { data: { status, error: finalStatus === 'failed' ? '上游 502' : undefined } }
      return jsonResponse(200, payload)
    }
    if (urlText.startsWith('https://img/')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    return new Response('unexpected', { status: 500 })
  }
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PROFILE = { baseUrl: 'https://api.apiz.ai', apiKey: 'k-test', timeoutMs: 60_000, pollIntervalMs: 1 }

test('callApizImageApi：create → 轮询 → 成图 URL + 积分（GPT-Image 参考图参数名）', async () => {
  const mock = mockApizFetch({ pendingQueries: 2 })
  try {
    const r = await callApizImageApi(
      { prompt: '{"风格模式":"x"}', model: 'apiz/gpt-image-2.5-flare', quality: 'low', aspectRatio: '1:1', inputImages: ['https://ref/a.jpg'] },
      PROFILE,
    )
    assert.equal(r.family, 'gpt-image')
    assert.equal(r.taskId, 'task-x1')
    assert.equal(r.price, 10)
    assert.deepEqual(r.imageUrls, ['https://img/a.jpg'])
    const create = JSON.parse(mock.calls.find((c) => c.url.endsWith('/create')).options.body)
    assert.deepEqual(create.params.reference_image_urls, ['https://ref/a.jpg'])
    assert.equal(mock.calls.filter((c) => c.url.endsWith('/query')).length, 3)
  } finally { mock.restore() }
})

test('callApizImageApi：任务失败带 task_id；缺 key 报配置指引', async () => {
  const mock = mockApizFetch({ finalStatus: 'failed' })
  try {
    await assert.rejects(
      () => callApizImageApi({ prompt: 'P', model: 'apiz/gpt-image-2.5-flare' }, PROFILE),
      /任务失败.*task-x1/,
    )
  } finally { mock.restore() }
  await assert.rejects(
    () => callApizImageApi({ prompt: 'P' }, { ...PROFILE, apiKey: '' }),
    /apizApiKey|apiz CLI/,
  )
})

test('waitForApizTask：轮询超时 → 不重提交指引（重复扣费红线）', async () => {
  const mock = mockApizFetch({ pendingQueries: 999 })
  try {
    await assert.rejects(
      () => waitForApizTask('task-x1', { ...PROFILE, timeoutMs: 80 }),
      (err) => {
        assert.match(err.message, /轮询超时/)
        assert.match(err.message, /不要重新提交/)
        assert.match(err.message, /task-x1/)
        return true
      },
    )
    // 全程只有 query，没有任何 create（没有重提交）
    assert.ok(mock.calls.every((c) => c.url.endsWith('/query')))
  } finally { mock.restore() }
})

// ---------------------------------------------------------------- generate.js · 组装与编排

test('assemblePrompt：对象序列化 + 特别要求追加；空报错', () => {
  const p = assemblePrompt({ 风格模式: 'x' }, '仅参考画风')
  assert.match(p, /^{\n  "风格模式"/)
  assert.match(p, /\n\n特别要求：仅参考画风$/)
  assert.equal(assemblePrompt('原文', ''), '原文')
  assert.throws(() => assemblePrompt('   '), /prompt 不能为空/)
})

test('normalizeReferenceInput：http/data 直传；相对路径与缺文件报错', () => {
  assert.equal(normalizeReferenceInput('https://a/b.jpg'), 'https://a/b.jpg')
  assert.ok(normalizeReferenceInput('data:image/png;base64,AAA').startsWith('data:image/png'))
  assert.throws(() => normalizeReferenceInput('rel/path.jpg'), /绝对路径/)
  assert.throws(() => normalizeReferenceInput(join(tmpdir(), 'ips-no-such-file.jpg')), /不存在/)
  assert.throws(() => normalizeReferenceInput(''), /不能为空/)
  const png = join(tmpdir(), `ips-ref-${Date.now()}.png`)
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.ok(normalizeReferenceInput(png).startsWith('data:image/png;base64,'))
})

test('runGenerate：端到端（mock HTTP + http 参考图）→ 落盘 + 历史存证 + Nano Banana 参数名', async () => {
  const mock = mockApizFetch({ pendingQueries: 1, images: ['https://img/one.jpg', 'https://img/two.jpg'] })
  try {
    const { record, files, result } = await runGenerate(
      {
        prompt: { 风格模式: '测试' },
        model: 'service-inference/gemini-nano-banana-2.1',
        aspectRatio: '1:1',
        sizeTier: '2K',
        referenceImages: ['https://ref/style.jpg'],
      },
      { apizApiKey: 'k-test', apizBaseUrl: 'https://api.apiz.ai', timeoutSeconds: 60, pollIntervalMs: 1, defaultModel: 'apiz/gpt-image-2.5-flare' },
    )
    assert.equal(result.family, 'nb')
    assert.equal(files.length, 2)
    assert.ok(files.every((f) => f.startsWith(IMAGES_DIR)))
    assert.ok(existsSync(files[0]))
    assert.equal(record.ok, true)
    assert.equal(record.price, 10)
    assert.equal(record.referenceCount, 1)
    assert.equal(record.family, 'nb')
    const create = JSON.parse(mock.calls.find((c) => c.url.endsWith('/create')).options.body)
    assert.deepEqual(create.params.image_urls, ['https://ref/style.jpg'])
    assert.equal(create.params.image_size, '2K')
    assert.ok(readHistory().some((r) => r.taskId === result.taskId && r.files.length === 2))
  } finally { mock.restore() }
})

test('runGenerate：未配置 key 时报兜底指引（apiz CLI）', async () => {
  const prevEnv = process.env.APIZ_API_KEY
  delete process.env.APIZ_API_KEY
  try {
    await assert.rejects(
      () => runGenerate({ prompt: { 风格模式: 'x' } }, { apizApiKey: '', apizUseCliAuth: false }),
      /apiz CLI 兜底|apizApiKey/,
    )
  } finally { if (prevEnv !== undefined) process.env.APIZ_API_KEY = prevEnv }
})

// ---------------------------------------------------------------- 工具层（tools.js：{schema, render} 输出契约 + 参数校验）

const { TOOLS, configRef } = await import('../lib/tools.js')

test('tools：五个工具齐备，output 契约 {schema, render} 且 schema additionalProperties:false', () => {
  const names = TOOLS.map((t) => t.name)
  assert.deepEqual(names.sort(), ['ips_diff', 'ips_generate', 'ips_history', 'ips_presets', 'ips_validate'])
  for (const tool of TOOLS) {
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} output schema 必须 additionalProperties:false`)
    for (const key of tool.output.schema.required) assert.ok(key in tool.output.schema.properties, `${tool.name} required 字段缺定义: ${key}`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.parameters.properties[tool.parameters.required[0]], `${tool.name} required 参数缺定义`)
  }
})

test('tools：ips_validate 校验通过/失败/解析错误三种回执', async () => {
  const tool = TOOLS.find((t) => t.name === 'ips_validate')
  const good = await tool.execute({ prompt: readFileSync(join(PRESETS_DIR, '海边中秋星野.json'), 'utf8') })
  assert.equal(good.ok, true)
  assert.match(good.summary, /校验通过/)
  assert.ok(good.data)

  const bad = await tool.execute({ prompt: '{"风格模式":"只有这一个"}' })
  assert.equal(bad.ok, false)
  assert.match(bad.summary, /校验未通过/)

  const broken = await tool.execute({ prompt: '不是 json' })
  assert.equal(broken.ok, false)
  assert.match(broken.summary, /JSON 解析失败/)
})

test('tools：ips_diff 回执含冻结率与逐字比对清单；部分模式校验 ips_validate partial', async () => {
  const validate = TOOLS.find((t) => t.name === 'ips_validate')
  const partialOnly = readFileSync(join(PRESETS_DIR, '中秋星野（仅角色）.json'), 'utf8')
  const r = await validate.execute({ prompt: partialOnly, partial: true })
  assert.equal(r.ok, true)

  const diffTool = TOOLS.find((t) => t.name === 'ips_diff')
  const doc = readFileSync(join(PRESETS_DIR, '海边中秋星野.json'), 'utf8')
  const same = await diffTool.execute({ before: doc, after: doc, intent: '不改' })
  assert.equal(same.ok, true)
  const payload = JSON.parse(same.data)
  assert.equal(payload.frozenRate, '100%')
  assert.equal(payload.changed.length, 0)

  const modified = JSON.parse(doc)
  modified['场景']['主体']['整体描述'] = '换主体'
  const changed = await diffTool.execute({ before: doc, after: JSON.stringify(modified), intent: '换个主体' })
  const payload2 = JSON.parse(changed.data)
  assert.equal(payload2.changed.length, 1)
  assert.equal(payload2.changed[0].path, '场景.主体.整体描述')
})

test('tools：ips_presets list/get/save/delete 全链路', async () => {
  const tool = TOOLS.find((t) => t.name === 'ips_presets')
  const list = await tool.execute({ action: 'list' })
  assert.equal(list.ok, true)
  assert.ok(JSON.parse(list.data).length >= 9)

  const got = await tool.execute({ action: 'get', name: '三国' })
  assert.equal(got.ok, true)
  assert.ok(JSON.parse(got.data)['风格模式'])

  const saved = await tool.execute({ action: 'save', name: '工具层预设', data: { 风格模式: '测试' } })
  assert.equal(saved.ok, true)
  const del = await tool.execute({ action: 'delete', name: '工具层预设' })
  assert.equal(del.ok, true)
  const delAgain = await tool.execute({ action: 'delete', name: '工具层预设' })
  assert.equal(delAgain.ok, false)
  const delBuiltin = await tool.execute({ action: 'delete', name: '三国' })
  assert.equal(delBuiltin.ok, false)
})

test('tools：ips_history list/remove/clear 与出图历史打通', async () => {
  const tool = TOOLS.find((t) => t.name === 'ips_history')
  clearHistory()
  addHistoryRecord({ ok: true, model: 'm', price: 5 })
  const list = await tool.execute({ action: 'list' })
  const payload = JSON.parse(list.data)
  assert.equal(payload.stats.total, 1)
  const id = payload.list[0].id
  assert.equal((await tool.execute({ action: 'remove', id })).ok, true)
  assert.equal((await tool.execute({ action: 'remove', id: 'ghost' })).ok, false)
  assert.equal((await tool.execute({ action: 'clear' })).ok, true)
})

test('tools：ips_generate 未配置 key 时的回执走 isError 语义（ok=false + 指引）', async () => {
  const tool = TOOLS.find((t) => t.name === 'ips_generate')
  configRef.config = { apizApiKey: '', apizUseCliAuth: false }
  const r = await tool.execute({ prompt: { 风格模式: 'x' } })
  assert.equal(r.ok, false)
  assert.match(r.summary, /apiz CLI|apizApiKey/)
})

// ---------------------------------------------------------------- 收尾（async 用例统一收口）

finish()
