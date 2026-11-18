// 本地自检：不建节点、不花积分。验证随包资源完整性（skill/预设/契约）、校验内核金标准、
// provider list/get、以及与上游 validate_prompt.py 的行为对齐（本机有 python 时）。
// 运行：node scripts/selftest.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ips-selftest-'))

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let failures = 0

function step(name, fn) {
  process.stdout.write(`- ${name} … `)
  try {
    fn()
    console.log('ok')
  } catch (err) {
    failures += 1
    console.log('失败')
    console.error(err)
  }
}

step('包完整性：cordis.patch.yml / icon.svg / locale / lab 入口', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('id: image-prompt-studio'), 'cordis.patch.yml 缺挂载 id')
  assert.ok(patch.includes("name: 'dsh-image-prompt-studio'"), 'cordis.patch.yml 缺插件名')
  assert.ok(existsSync(join(ROOT, 'icon.svg')), '缺 icon.svg')
  assert.ok(existsSync(join(ROOT, 'lab', 'index.html')), '缺 lab/index.html')
  for (const locale of ['zh.json', 'en.json']) {
    const data = JSON.parse(readFileSync(join(ROOT, 'locale', locale), 'utf8'))
    assert.ok(data.meta.title && data.meta.description, `locale/${locale} 缺 meta`)
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.engines.dsh.includes('0.2'), 'engines.dsh 未锁定 0.2.x')
  assert.ok(pkg.dependencies['@deepseek-ai/schemastery'], 'schemastery 必须声明 dependencies（否则 cordis 报 ~standard 缺失）')
  assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'], 'schemastery 必须同时声明 peerDependencies')
})

const { parsePrompt, validatePrompt, diffPrompts } = await import('../lib/check.js')

step('随包 skill：SKILL.md frontmatter / NOTICE / 4 份 references / 9 套预设', async () => {
  const skillDir = join(ROOT, 'skills', 'image-prompt-studio')
  const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  const m = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  assert.ok(m, 'SKILL.md 缺 frontmatter')
  assert.ok(m[1].includes('name: image-prompt-studio'), 'SKILL.md name 不对')
  assert.ok(m[1].includes('agent_created: true'), 'SKILL.md 缺 agent_created 标记')
  assert.ok(existsSync(join(skillDir, 'NOTICE.md')), '缺 NOTICE.md（快照来源与授权说明）')
  for (const ref of ['prompt-schema.md', 'system-prompts.md', 'options-library.md', 'image-generation.md']) {
    assert.ok(existsSync(join(skillDir, 'references', ref)), `缺 references/${ref}`)
  }
  const presets = readdirSync(join(skillDir, 'assets', 'presets')).filter((f) => f.endsWith('.json'))
  assert.equal(presets.length, 9, `预设应 9 套，实际 ${presets.length}`)
})

step('快照纪律：SKILL.md 提到 scripts/validate_prompt.py（独立环境保留 python 校验器）', async () => {
  const skillText = readFileSync(join(ROOT, 'skills', 'image-prompt-studio', 'SKILL.md'), 'utf8')
  assert.ok(skillText.includes('ips_validate'), 'SKILL.md 应指向 ips_validate 工具')
  assert.ok(skillText.includes('ips_diff'), 'SKILL.md 应指向 ips_diff 工具')
  assert.ok(skillText.includes('ips_generate'), 'SKILL.md 应指向 ips_generate 工具')
  assert.ok(skillText.includes('<SKILL_ROOT>'), 'SKILL.md 应使用 <SKILL_ROOT> 占位符')
  assert.ok(existsSync(join(ROOT, 'skills', 'image-prompt-studio', 'scripts', 'validate_prompt.py')), '缺独立环境用的 python 校验器')
})

step('provider：list 返回 1 个 skill；get 正文替换 <SKILL_ROOT> 并带插件 addendum', async () => {
  const { createSkillProvider } = await import('../lib/skills.js')
  const provider = createSkillProvider([join(ROOT, 'skills')], ROOT)
  const list = await provider.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'image-prompt-studio')
  assert.equal(list[0].rank, 600, 'rank 600（用户自装同名 skill 优先）')
  const full = await provider.get(list[0])
  assert.ok(!full.content.includes('<SKILL_ROOT>'), 'get 正文不应残留 <SKILL_ROOT> 占位符')
  assert.ok(!full.content.includes('<PLUGIN_ROOT>'), 'get 正文不应残留 <PLUGIN_ROOT> 占位符')
  assert.ok(full.content.includes('ips_validate'), 'addendum 应说明 ips_validate 替代 python 校验')
  assert.ok(full.content.includes('创作归你'), 'addendum 应声明创作边界')
})

step('校验内核金标准：9 套预设部分模式全过；完整结构预设零 error', async () => {
  const presetsDir = join(ROOT, 'skills', 'image-prompt-studio', 'assets', 'presets')
  const knownPartial = new Set(['中秋星野（仅角色）.json', '雪景下的中秋星野.json'])
  for (const file of readdirSync(presetsDir).filter((f) => f.endsWith('.json'))) {
    const data = parsePrompt(readFileSync(join(presetsDir, file), 'utf8'))
    const partialReport = validatePrompt(data, { partial: true })
    assert.ok(partialReport.passed, `${file} 部分模式应通过`)
    if (knownPartial.has(file)) continue
    const report = validatePrompt(data)
    assert.deepEqual(report.errors, [], `${file} 完整模式不应有 error`)
  }
})

step('冻结比对金标准：改 11 个叶子字段 → 28 叶 / 17 冻结 / 61%', async () => {
  const preset = parsePrompt(readFileSync(join(ROOT, 'skills', 'image-prompt-studio', 'assets', 'presets', '海边中秋星野.json'), 'utf8'))
  const after = structuredClone(preset)
  const sub = after['场景']['主体']
  for (const key of ['整体描述']) sub[key] = '改'
  for (const key of ['身材', '面部', '头发', '眼睛']) sub['外形特征'][key] = '改'
  for (const key of ['情绪', '动作']) sub['表情与动作'][key] = '改'
  for (const key of ['穿着', '细节']) sub['服装'][key] = '改'
  after['场景']['环境']['地点设定'] = '改'
  after['相机']['机位角度'] = '改'
  const diff = diffPrompts(preset, after)
  assert.equal(diff.changed.length, 11)
  assert.equal(diff.frozenRate, 61)
})

step('与上游 validate_prompt.py 对齐（本机有 python 时）', () => {
  const pyScript = join(ROOT, 'skills', 'image-prompt-studio', 'scripts', 'validate_prompt.py')
  let python = null
  for (const bin of ['python', 'py']) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); python = bin; break } catch { /* 下一个 */ }
  }
  if (!python) { console.log('（本机无 python，跳过）'); return }
  const good = join(ROOT, 'skills', 'image-prompt-studio', 'assets', 'presets', '海边中秋星野.json')
  execFileSync(python, [pyScript, good], { stdio: 'ignore' })
  assert.ok(validatePrompt(parsePrompt(readFileSync(good, 'utf8'))).passed, 'JS 与 Python 结论应一致（通过）')
})

step('数据层：DSH_HOME 隔离目录可写（预设/历史/成图目录）', async () => {
  const { ensureDirs, listPresets, DATA_DIR } = await import('../lib/data.js')
  ensureDirs()
  assert.ok(existsSync(DATA_DIR), '数据目录未创建')
  assert.ok(listPresets().length >= 9, '预设列表为空')
})


rmSync(process.env.DSH_HOME, { recursive: true, force: true })
if (failures) {
  console.error(`\n自检失败：${failures} 步`)
  process.exit(1)
}
console.log('\n自检全部通过')
