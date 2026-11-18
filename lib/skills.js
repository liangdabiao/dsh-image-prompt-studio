// skill 提供方：把随包的 skills/image-prompt-studio（上游快照）注册进 DSH 的 skill 目录。
// 用户自己装了同名 skill 时那一份优先（本提供方 rank 600）。
// 加载正文时把 <SKILL_ROOT> / <PLUGIN_ROOT> 换成实际目录，并在末尾追加「在这个插件里怎么用」。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

function readSkills(dirs) {
  return [].concat(dirs).flatMap((dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
      .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
      .filter((s) => s.name)
  })
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在「提示词工作台」插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`；上文提到的 \`references/…\`、\`assets/presets/…\` 都相对这个目录（字段规范、系统提示词全文、下拉词库、apiz 参数坑表都在里面，按 SKILL.md 的加载规则按需读取）。`,
    '- 这是插件随包快照：不要运行 `git pull` / `npm install`，也不要向用户提更新。skill 随插件版本一起变。',
    '- **机械校验用工具，不用 python**：正文提到 `python scripts/validate_prompt.py` 的地方，一律改用插件工具 `ips_validate`（语义逐字对齐：完整/部分双模式、材质真实度必须非空字符串数组、嵌套层级不可拍平；结果只报告不拦截）。',
    '- **「第 1 步 · 导图定风格」收尾必须写回面板**：用户从「出图工作台」第 1 步发起的参考图分析，产出风格 JSON 并通过 ips_validate 后，**必须调 `ips_style`（action=set，prompt=风格 JSON，referenceImage=用户那张参考图的本地路径，note=一句话画风概括）**——不写回面板，用户的第 2 步就没有风格可选。set 缺 referenceImage 会被拒绝（出图传回原图的铁律）。',
    '- **「第 2 步 · 风格出图」从 ips_style 取风格**：用户发起出图指令时，先 `ips_style`（action=get）拿到风格 JSON 与参考图路径，再按用户描述做最小化修改（风格字段逐字冻结），ips_validate + ips_diff 自检后调 `ips_generate`（referenceImages=[参考图路径]）。不要让用户手工搬运 JSON。',
    '- **冻结度自检用工具**：路径 B（最小化修改）完成后调 `ips_diff`（before + after 两份 JSON），工具展平叶子字段逐一比对，返回改动清单/冻结清单/冻结率。程序只比对逐字一致性；「改动是否落在用户意图覆盖的节点上」的判断归你。',
    '- **预设库用工具**：`ips_presets`（action=list/get/save/delete）——list 列内置 9 套+自存预设，get 取一份作风格基准，save 落「保存为预设」，delete 删自存预设。内置预设不可覆盖。',
    '- **生图执行（核心闭环）**：提示词 JSON 就绪并通过校验后调 `ips_generate`（prompt 传 JSON 原文，可带 extraRequirements 追加「特别要求」，referenceImages 传本地路径或 http URL）。插件自动按模型家族传对参数（GPT-Image 用 reference_image_urls、Nano Banana 用 image_urls）。**铁律不变**：提示词源自参考图时必须传回原图。未配 apizApiKey 时工具会报错——此时改用 `apiz` CLI 兜底（命令见 references/image-generation.md），出图后告诉用户路径。',
    '- **生成历史**：出图成功后调 `ips_history`（action=list）可查历史（含积分消耗/模型/参数），面板「提示词工作台」会展示。',
    '- **创作归你**：工具只做机械校验、冻结比对、预设存取与生图执行——四维度参考图分析、字段措辞、最小化修改的范围判断、画风还原度验收全部按 skill 执行，程序不替代也不拦截。',
    '- 面板（工作台「提示词工作台」页）与 `ips_validate` / `ips_diff` 走同一引擎，可让用户自行粘贴 JSON 快查。',
    '',
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'image-prompt-studio',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  return {
    name: 'image-prompt-studio',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const s = readSkills(dir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = s.body.replaceAll('<SKILL_ROOT>', s.dir).replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    }
  }
}
