// 提示词工作台 · Host 半边
// 1. 把随包的 skill（skills/image-prompt-studio）注册进 ctx.skills，模型和 /skill 都能用
// 2. 注册六个工具（lib/tools.js）：结构校验、冻结度比对、预设库、风格槽、apiz 生图、生成历史
// 3. /image-prompt-studio 工作台：静态页面（lab/）+ 数据接口（lib/api.js）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { registerApi } from './lib/api.js'
import { createSkillProvider } from './lib/skills.js'
import { TOOLS, configRef } from './lib/tools.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const SKILL_DIRS = [join(ROOT, 'skills')]

export const name = 'image-prompt-studio'
export const inject = ['webServer', 'skills', 'tools']

export const Config = Schema.object({
  apizBaseUrl: Schema.string().default('https://api.apiz.ai').description('apiz API 地址'),
  apizApiKey: Schema.string().default('').role('secret').description('apiz API Key（留空且本机 apiz CLI 已登录时可在 apizUseCliAuth 开启后复用登录态）'),
  apizUseCliAuth: Schema.boolean().default(false).description('复用本机 apiz CLI 登录态（~/.config/apiz/config.toml 的 api_key）'),
  defaultModel: Schema.string().default('apiz/gpt-image-2.5-flare').description('默认模型：apiz/gpt-image-2.5-flare（GPT-Image 路线）或 service-inference/gemini-nano-banana-2.1（Nano Banana 路线）'),
  quality: Schema.string().default('low').description('GPT-Image 质量档位：low / medium / high / xhigh / max（默认 low，10 积分/张）'),
  apizBin: Schema.string().default('').description('apiz CLI 路径（参考图上传走 CLI upload；留空用 PATH 里的 apiz）'),
  timeoutSeconds: Schema.number().default(900).description('生图轮询超时（秒）。超时不重提交，拿 task_id 用 `apiz tasks get` 续取'),
})

export function apply(ctx, config) {
  configRef.config = config ?? {}
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIRS, ROOT)))
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => registerApi(ctx))
}
