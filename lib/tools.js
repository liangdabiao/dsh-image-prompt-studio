// 插件工具集：结构校验 + 冻结比对 + 预设库 + 生图执行 + 生成历史。
// 创作边界：四维参考图分析、字段措辞、最小化修改范围判断归 skill（LLM）；
// 程序只做结构/类型机械校验、逐字一致性比对、预设存取与生图执行——校验不通过报告不拦截。
import { parsePrompt, validatePrompt, diffPrompts } from './check.js'
import { listPresets, getPreset, savePreset, deletePreset, readHistory, removeRecord, clearHistory, summarizeHistory, readStyle, saveStyle, clearStyle } from './data.js'
import { runGenerate } from './generate.js'

// 配置引用：index.js 在 apply 时写入；宿主改配置会重新 apply。
export const configRef = { config: {} }

export function getConfig() {
  return configRef.config ?? {}
}

// ---------------------------------------------------------------- 输出契约

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的简短回执' },
      data: { type: 'string', description: '结构化结果的 JSON 字符串（面板/调试用）' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.data ? `${value.summary}\n\n${value.data}` : value.summary }],
}

const result = (ok, summary, data) => (data === undefined ? { ok, summary } : { ok, summary, data })
const toData = (value) => JSON.stringify(value, null, 2)
const fail = (err) => result(false, `❌ ${String((err && err.message) || err)}`)

const REF_PARAM = {
  anyOf: [
    { type: 'string', description: '提示词 JSON 原文（或任意 JSON 文本）' },
    { type: 'object', description: '已解析的提示词 JSON 对象' },
  ],
}

// ---------------------------------------------------------------- 工具定义

export const TOOLS = [
  {
    name: 'ips_validate',
    description: '结构化 JSON 绘图提示词的结构校验器（完整/部分双模式）。校验 26 个必需字段的齐全性、类型红线（「审美控制.材质真实度」必须为非空字符串数组、嵌套层级不可拍平）与空值。生成或修改提示词后必须调用；校验不通过只报告清单不拦截，按清单修完再交付用户。完整结构预设用 partial=false；「仅角色」等部分结构预设用 partial=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: REF_PARAM,
        partial: { type: 'boolean', description: 'true=部分模式：只校验已存在字段（「仅角色」等部分结构预设）；默认 false 完整模式' },
      },
    },
    timeoutMs: 10_000,
    output: OUTPUT,
    async execute(args) {
      try {
        const data = parsePrompt(args.prompt)
        const report = validatePrompt(data, { partial: args.partial === true })
        const mode = args.partial === true ? '部分模式' : '完整模式'
        if (report.passed) {
          const note = report.warnings.length ? `；另有 ${report.warnings.length} 条提醒（部分模式跳过项）` : ''
          return result(true, `✅ ${mode}校验通过（核对 ${report.checkedFields} 个字段）${note}`, toData(report))
        }
        return result(false, `❌ ${mode}校验未通过，共 ${report.errors.length} 个问题：${report.errors.slice(0, 6).join('；')}${report.errors.length > 6 ? ' 等' : ''}（报告不拦截，按清单修正后再交付）`, toData(report))
      } catch (err) {
        return fail(err)
      }
    },
  },

  {
    name: 'ips_diff',
    description: '最小化修改（路径 B）的冻结度程序化自检：把修改前后两份提示词展平成叶子字段逐一比对，返回改动字段清单（含路径与前后值）、逐字冻结字段清单、新增/删除字段与冻结率。只做逐字一致性比对；「改动是否落在用户修改指令覆盖的节点上」由你按 skill 纪律判断——意图外的改动说明修改发散了，应重改。修改完成后必须调用一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: {
        before: REF_PARAM,
        after: REF_PARAM,
        intent: { type: 'string', description: '用户的修改指令原文（仅回显进结果，便于人工核对改动是否对应意图；程序不做判断）' },
      },
    },
    timeoutMs: 10_000,
    output: OUTPUT,
    async execute(args) {
      try {
        const before = parsePrompt(args.before)
        const after = parsePrompt(args.after)
        const diff = diffPrompts(before, after)
        const digest = {
          intent: args.intent || undefined,
          totalLeaves: diff.totalLeaves,
          frozenRate: `${diff.frozenRate}%`,
          changed: diff.changed.map((c) => ({ path: c.path, before: c.before.slice(0, 60), after: c.after.slice(0, 60) })),
          frozen: diff.frozen,
          added: diff.added,
          removed: diff.removed,
        }
        const summary = `改动 ${diff.changed.length} 个字段 / 冻结 ${diff.frozen.length} 个（冻结率 ${diff.frozenRate}%）` +
          (diff.added.length ? `；新增 ${diff.added.length} 个字段` : '') +
          (diff.removed.length ? `；删除 ${diff.removed.length} 个字段` : '') +
          `。程序只比对逐字一致性：改动清单是否全部落在修改指令覆盖的节点上，请按「最小化修改」纪律自查。`
        return result(true, `✅ 冻结度比对完成：${summary}`, toData(digest))
      } catch (err) {
        return fail(err)
      }
    },
  },

  {
    name: 'ips_presets',
    description: '绘图提示词预设库：list=列出内置 9 套预设（Q版/三国/宋代/线稿漫画/讽刺漫画/中秋星野系列等）与用户自存预设；get=取一份预设完整 JSON（生成新提示词时可作风格基准再改写字段）；save=把当前提示词 JSON 存为用户预设（用户说「保存为预设」时用；内置预设只读不可覆盖）；delete=删除用户预设（内置不可删）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'save', 'delete'], description: '操作类型' },
        name: { type: 'string', description: '预设名（get/save/delete 必填）' },
        data: { type: 'object', description: 'save 时要存的提示词 JSON 对象（必填）' },
      },
    },
    timeoutMs: 10_000,
    output: OUTPUT,
    async execute(args) {
      try {
        if (args.action === 'list') {
          const presets = listPresets()
          return result(true, `共 ${presets.length} 套预设（builtin=内置只读）`, toData(presets))
        }
        if (args.action === 'get') {
          const preset = getPreset(args.name)
          if (!preset) return result(false, `❌ 没有这个预设：${args.name}（可用 ips_presets action=list 查看）`)
          return result(true, `✅ 已读取预设「${preset.name}」（${preset.builtin ? '内置' : '用户'}${preset.partial ? '，部分结构' : ''}）`, toData(preset.data))
        }
        if (args.action === 'save') {
          if (!args.data || typeof args.data !== 'object') return result(false, '❌ save 需要 data（提示词 JSON 对象）')
          const saved = savePreset(args.name, args.data)
          return result(true, `✅ 已保存用户预设「${saved.name}」`, toData(saved))
        }
        if (args.action === 'delete') {
          const removed = deletePreset(args.name)
          return removed
            ? result(true, `✅ 已删除用户预设「${String(args.name).replace(/[\\/:*?"<>|]/g, '_')}」`)
            : result(false, `❌ 没有这个用户预设（内置预设不可删）：${args.name}`)
        }
        return result(false, `❌ 未知 action：${args.action}`)
      } catch (err) {
        return fail(err)
      }
    },
  },

  {
    name: 'ips_style',
    description: '当前风格槽：面板「出图工作台」两步向导的枢纽。参考图分析（路径 A 带图）完成后必须调 ips_style（action=set）把风格 JSON 写回面板，用户才能在 Step2 选风格+描述要求出图；set 需同时带上你分析用的那张参考图路径（面板出图时会自动作为风格参考传回——参考图铁律）。action=get 取当前风格（含参考图路径），action=list 列用户保存的风格库，action=clear 清空当前槽。执行 Step2 出图指令时，先 ips_style（action=get）取风格 JSON 与参考图，再按用户描述做最小化修改，最后 ips_generate。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'list', 'clear'], description: '操作类型' },
        prompt: { type: 'object', description: 'set 时必填：分析得到的风格提示词 JSON 对象（完整 26 字段结构）' },
        referenceImage: { type: 'string', description: 'set 时必填：你分析用的那张参考图的本地绝对路径（出图时自动传回作风格参考）' },
        note: { type: 'string', description: 'set 可选：一句话风格说明（面板风格卡上展示）' },
      },
    },
    timeoutMs: 10_000,
    output: OUTPUT,
    async execute(args) {
      try {
        if (args.action === 'get') {
          const style = readStyle()
          if (!style) return result(false, '❌ 面板还没有当前风格：先完成第 1 步（参考图分析）并 ips_style action=set 写回')
          return result(true, `✅ 当前风格（${style.updatedAt?.slice(0, 19).replace('T', ' ')}，参考图 ${style.referenceImage || '无'}）`, toData(style))
        }
        if (args.action === 'set') {
          if (!args.prompt || typeof args.prompt !== 'object') return result(false, '❌ set 需要 prompt（风格提示词 JSON 对象）')
          if (!args.referenceImage) return result(false, '❌ set 需要 referenceImage（你分析用的参考图绝对路径——出图时要传回的铁律）')
          const saved = saveStyle({ prompt: args.prompt, referenceImage: args.referenceImage, note: args.note })
          return result(true, '✅ 已写回面板「出图工作台」：用户可在 Step2 选这个风格+描述要求出图', toData({ updatedAt: saved.updatedAt, referenceImage: saved.referenceImage, note: saved.note }))
        }
        if (args.action === 'list') {
          const styles = listStyles()
          return result(true, `风格库共 ${styles.length} 套（name/referenceImage/note 摘要）`, toData(styles.map((s) => ({ id: s.id, name: s.name, note: s.note, referenceImage: s.referenceImage, savedAt: s.savedAt }))))
        }
        if (args.action === 'clear') {
          return clearStyle() ? result(true, '✅ 已清空当前风格') : result(true, '当前本来就是空的')
        }
        return result(false, `❌ 未知 action：${args.action}`)
      } catch (err) {
        return fail(err)
      }
    },
  },

  {
    name: 'ips_generate',
    description: 'apiz 双模型生图执行（面板「提示词工作台」同款引擎）。prompt 传结构化 JSON 提示词原文（工具自动按模型家族传对参考图参数：GPT-Image 用 reference_image_urls、Nano Banana 用 image_urls）。铁律：提示词源自参考图时，referenceImages 必须把那张原图传回（本地绝对路径或 http URL），否则画风还原度大幅下降。默认 apiz/gpt-image-2.5-flare + quality=low（10 积分/张）；单张生成约 2-9 分钟，轮询超时不会重提交（防重复扣费），超时后拿返回的 taskId 用 `apiz tasks get` 续取。未配置 apizApiKey 时报错——此时用 apiz CLI 兜底出图并把路径告诉用户。出图成功自动落盘并写生成历史。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: REF_PARAM,
        extraRequirements: { type: 'string', description: '用户额外要求，以「特别要求：」追加在 JSON 之后' },
        model: { type: 'string', description: '模型 ID：apiz/gpt-image-2.5-flare（默认）/ apiz/gpt-image-2.5-sunburst / service-inference/gemini-nano-banana-2.1 / fal-ai/nano-banana-pro' },
        quality: { type: 'string', description: 'GPT-Image 质量档位 low/medium/high/xhigh/max（默认取插件设置，low=10 积分）' },
        aspectRatio: { type: 'string', description: '比例，默认 1:1；GPT-Image 可用 21:9/16:9/3:2/4:3/5:4/1:1/4:5/3:4/2:3/9:16；Nano Banana 另支持 1:4/1:8/4:1/8:1 超长比例' },
        sizeTier: { type: 'string', description: 'Nano Banana 分辨率档 1K/2K/4K（默认 1K；GPT-Image 忽略）' },
        referenceImages: {
          type: 'array', items: { type: 'string' }, maxItems: 16,
          description: '风格参考图：本地绝对路径或 http(s) URL。源自参考图的提示词必须传回原图（硬性规则）',
        },
      },
    },
    timeoutMs: 900_000,
    output: OUTPUT,
    async execute(args) {
      try {
        const { record, files, result: gen } = await runGenerate(args, getConfig())
        const priceText = typeof record.price === 'number' ? `，消耗 ${record.price} 积分` : ''
        const refText = record.referenceCount ? `，参考图 ${record.referenceCount} 张已传回` : '，无参考图'
        const warnText = gen.warnings.length ? `。提醒：${gen.warnings.join('；')}` : ''
        return result(true, `✅ 出图完成（${Math.round(record.durationMs / 1000)}s${priceText}${refText}）${warnText}\n成图：\n${files.join('\n')}`, toData({ record, files }))
      } catch (err) {
        return fail(err)
      }
    },
  },

  {
    name: 'ips_history',
    description: '生成历史查询与管理：list=查询出图历史（模型/比例/参考图数/积分/耗时/成图路径）；remove=删除一条记录；clear=清空全部历史。面板「提示词工作台」与工具走同一份数据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'remove', 'clear'], description: '操作类型' },
        id: { type: 'string', description: 'remove 时的记录 id' },
        limit: { type: 'number', description: 'list 返回条数上限（默认 30）' },
      },
    },
    timeoutMs: 10_000,
    output: OUTPUT,
    async execute(args) {
      try {
        if (args.action === 'list') {
          const all = readHistory()
          const list = all.slice(0, Math.max(1, Math.min(200, Number(args.limit) || 30)))
          return result(true, `共 ${all.length} 条历史，返回前 ${list.length} 条`, toData({ stats: summarizeHistory(all), list }))
        }
        if (args.action === 'remove') {
          return removeRecord(String(args.id || ''))
            ? result(true, '✅ 已删除该条历史记录')
            : result(false, `❌ 没有这条记录：${args.id}`)
        }
        if (args.action === 'clear') {
          return result(true, `✅ 已清空 ${clearHistory()} 条历史记录`)
        }
        return result(false, `❌ 未知 action：${args.action}`)
      } catch (err) {
        return fail(err)
      }
    },
  },
]
