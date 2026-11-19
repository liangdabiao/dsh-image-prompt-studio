---
name: image-prompt-studio
description: 结构化 JSON 提示词生成与修改（AI 绘画工作流）。当用户需要用一句话描述生成完整结构化 JSON 绘图提示词、对已有 JSON 提示词做精准最小化修改、从参考图反推提示词、按二次元立绘等风格创作画面，或把提示词通过 apiz 接入 Nano Banana / GPT-Image 生图时使用。内含字段规范、生成/修改系统提示词、下拉词库、9 套预设范例与 apiz 生图参数手册。
agent_created: true
---

# Image Prompt Studio Skill

## Overview

把「Nano Banana Prompt Studio」项目的提示词工程知识固化为可复用 skill：用结构化 JSON（而非长段自然语言）控制 AI 生图，实现精准定制、模块化复用与系列作品的一致性。本 skill 覆盖四条主路径：生成新提示词、最小化修改、参考图反推、出图。**生成的 JSON 提示词同时兼容 Nano Banana 与 GPT-Image 两个模型家族。**

## 工作流决策树

按用户意图选择入口：

| 用户意图 | 入口 |
|---|---|
| 描述一个想要的画面 / 要一份新提示词 | 路径 A：生成 |
| 拿着已有 JSON 说"改 XX / 换成 XX" | 路径 B：最小化修改 |
| 给了参考图，要仿照/反推提示词 | 路径 A + 参考图分析 |
| 提示词就绪，要实际出图 | 路径 C：出图执行 |

## 核心输出规则（所有路径通用）

1. 只输出 JSON 本体：严禁 markdown 代码块包裹（无 ```json）、严禁任何解释性文字。
2. 结构完整：所有字段必须填写，不得遗漏、不得留空。
3. 用词要求：有画面感，专业、优美、具体；避免模糊表述。
4. 非人物主体（风景、物品、战场等）时，主体下的外形特征类字段按实际对象调整描述，不硬套人物字段。
5. 生成或修改完成后，运行结构校验（插件里用 `ips_validate` 工具，不用 python；独立环境可用 `<SKILL_ROOT>/scripts/validate_prompt.py`）。

## 路径 A：生成新提示词

1. 读取 `<SKILL_ROOT>/references/system-prompts.md` 中的 `SYSTEM_PROMPT` 全文，作为本次生成的系统指令严格执行。
2. 若用户提供参考图片：**由运行时 agent 直接读图分析**——用自身多模态视觉能力打开图片文件，按 SYSTEM_PROMPT 要求的四个维度提取特征（角色特征、场景环境、画面风格、构图与镜头角度），再结合用户文字描述生成提示词。**不调用外部视觉模型 API**，分析由 agent 本身完成。**记下参考图的文件路径**：后续路径 C 出图时必须把它作为风格参考传回（见路径 C 第 2 步）。
3. 用户无参考图时，直接按其自然语言描述生成。
4. 字段填写规范与各字段写法要领见 `<SKILL_ROOT>/references/prompt-schema.md`；可从 `<SKILL_ROOT>/references/options-library.md` 的词库中选用或组合高质量措辞（词库是素材不是枷锁，按画面需要自由发挥）。
5. 输出前用校验确认结构无误，再把 JSON 交付用户（保存为 `.json` 文件或直接展示）。
6. 需要风格基准时用 `ips_presets`（action=get）取最贴近的预设改写字段。
7. **「出图工作台」第 1 步发起的分析，收尾必须调 `ips_style`（action=set）把风格 JSON 连同参考图路径写回面板**——用户在第 2 步等着选这个风格出图。

## 路径 B：最小化修改已有提示词

1. 读取 `<SKILL_ROOT>/references/system-prompts.md` 中的 `MODIFY_SYSTEM_PROMPT` 全文，严格执行「最小化修改」原则：
   - 精准打击：只改用户明确要求或逻辑上必须联动改变的字段（夏天→冬天时，短袖→棉袄是必须，发色/构图绝不能动）。
   - 完全冻结：未触及字段必须与原 JSON 逐字一致，禁止同义词替换、润色、格式优化。
   - 禁止发散：不"修复"任何用户没提的参数。
2. 输出修改后的**完整 JSON**（不是 diff、不是片段）。
3. 同样过一遍结构校验。
4. 冻结度自检（必做）：调 `ips_diff`（before=原 JSON，after=修改后 JSON），工具展平叶子字段程序化比对，返回改动清单、冻结清单与冻结率。改动是否落在用户意图覆盖的节点上由你判断——意图外的改动说明修改发散了，重改。实测参考见插件根目录 `README.md` 的「实测结论」（26 个叶子字段中 11 个改动、15 个逐字冻结）；示例 JSON 未随包分发，需要风格基准时用 `ips_presets`（action=get）取内置预设。

## 路径 C：出图执行

提示词 JSON 就绪后出图。**同一份 JSON 同时兼容 Nano Banana 与 GPT-Image 两个模型家族**，按用户偏好或画面需求选择路线。

1. 组装 prompt：把 JSON 原文（`JSON.stringify(data, null, 2)` 带中文原样）作为 prompt 文本；用户有额外要求时，以 `"\n\n特别要求：<要求>"` 形式追加在 JSON 之后。
2. **带参考图（硬性规则）**：只要本次提示词是从参考图分析/修改得来的，出图时**必须**把那张原图一并作为风格参考传入——分析完就把原图丢掉是实测 bug，画风还原度会大幅下降。插件工具 `ips_generate` 的 `referenceImages` 参数传本地路径或 http URL 即可（GPT-Image 自动走 `reference_image_urls`，Nano Banana 自动走 `image_urls`，不用记参数名）。无参考图的纯文生图才可省略。
3. 选择模型：
   - **GPT-Image 路线（默认）**：`apiz/gpt-image-2.5-flare`，质量默认 `low`（10 积分/张，约 0.1 元）。
   - **Nano Banana 路线**：`service-inference/gemini-nano-banana-2.1`，文生图与参考图编辑同一端点，支持最多 14 张参考图。
   - 参数细节与完整模型表见 `<SKILL_ROOT>/references/image-generation.md`。
4. 执行：优先调插件工具 `ips_generate`（同一引擎，面板「提示词工作台」也用它）；插件未配 apizApiKey 且 CLI 未登录时报错，此时改用 apiz CLI 兜底：
   ```bash
   apiz generate "$(cat prompt.json)" --model apiz/gpt-image-2.5-flare \
     --aspect-ratio 1:1 \
     --params '{"quality":"low","reference_image_urls":["<public_url>"]}' \
     --wait --json
   ```
   `--aspect-ratio` 参照原图或用户要求（竖构图 3:4 / 横构图 16:9 / 方形 1:1 等）；生成耗时 2-9 分钟，CLI `--wait` 会阻塞至完成，超时风险高的场合改用后台运行。**轮询超时不要重跑（重复扣费）**，用 `apiz tasks wait <task_id> --json` 续接。
5. 出图完成后把成片路径与所用提示词一起向用户展示；插件会自动把记录写进生成历史（面板可见）。
6. 出图前如余额不明，先 `apiz account balance` 确认；积分不足时所有模型返回 HTTP 429。

## 预设与范例

- 用 `ips_presets`（action=list）查看 9 套内置预设（Q版、三国、宋代、线稿漫画、讽刺漫画、中秋星野系列等），覆盖人物立绘、场景、风格化等典型场景。
- 生成提示词时，可读取最贴近用户需求的一套作为风格基准，再按用户描述替换对应字段。
- 用户说"保存为预设"时，用 `ips_presets`（action=save）把当前 JSON 写入用户预设库并命名。

## Resources

### references/
- `prompt-schema.md` — JSON 字段规范：每个字段的含义、填写要领、非人物主体的调整规则、可选负向字段、与两个模型家族的兼容性说明。生成前必读。
- `system-prompts.md` — `SYSTEM_PROMPT`（生成）与 `MODIFY_SYSTEM_PROMPT`（修改）全文，附运行时 agent 执行说明。执行路径 A/B 时原样遵循。
- `options-library.md` — 全量下拉选项词库（风格模式、画面气质、机位角度、构图、镜头、光线、天气、服装、色彩等），含角色线稿专用提示词。选词素材库。
- `image-generation.md` — 出图操作手册：命令模板、Nano Banana 与 GPT-Image 双模型参数表、参考图传法、质量档位与价格、余额闸门、已知坑。

### assets/
- `presets/*.json` — 9 套预设范例，可直接加载、改写或作为风格基准。

### scripts/（独立环境用；插件里用 ips_validate / ips_diff 工具）
- `validate_prompt.py` — 结构校验器。用法：`python validate_prompt.py <prompt.json>`；部分结构预设加 `--partial`；缺字段时逐条列出，退出码非 0。

## 来源

本 skill 提炼自本地项目 `D:/nano-b/nano-banana-prompt-studio`（PyQt6 桌面端 + Flask Web 端的 Nano Banana Prompt Studio）。需要 GUI 客户端、Web 服务或 PyInstaller 打包能力时，直接使用该项目源码；本 skill 只承载其提示词工程知识，不依赖该项目运行。生图通道统一走 apiz（2026-10-14 起替代原项目的 Gemini SDK / 302 中转直连）。
