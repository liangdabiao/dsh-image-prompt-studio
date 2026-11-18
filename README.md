# dsh-image-prompt-studio · 提示词工作台

复刻图片风格，模仿风格生图！用户只要两步：**① 导入一张风格图 → ② 描述想画的画面 → 出图**。风格提示词（结构化 JSON，26 个中文叶子字段）是内部机制，由对话里的 agent 按随包 skill 自动生成与修改，用户不需要碰；同一份 JSON 同时兼容 **Nano Banana 与 GPT-Image** 双模型家族，出图统一走 apiz。

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-image-prompt-studio
```

## 用户流程（面板首屏「出图工作台」，就两步）

```
第 1 步 · 导图定风格
  上传一张喜欢的风格图（或填本地路径）
  → 点「分析这张图，生成风格」→ 自动开对话
  → agent 读图按四维度分析（角色/场景/画风/构图），产出风格提示词
  → agent 自动把风格写回面板（ips_style），第 2 步的「风格已就绪」卡自动亮起

第 2 步 · 风格生图
  从风格库（或刚生成的当前风格）选一套风格 + 写描述要求（想画什么）
  → 点「生成图片」→ 自动开对话
  → agent 把描述融进画面主体（风格字段逐字冻结，画风不漂移）
  → agent 自动带上该风格的参考图调 ips_generate 出图
  → 成图出现在「生成历史」（含积分/耗时/参数）
```

参考图铁律在风格与出图之间自动成立：每套风格都记着自己的参考图，出图时自动传回作风格参考——这是画风还原度的关键。第 1 步产出的风格可一键「保存到风格库」，下次生图直接从库里选。

## 六个工具

| 工具 | 职责 |
|---|---|
| `ips_style` | 当前风格槽（两步向导枢纽）：set=agent 分析完把风格 JSON+参考图路径写回面板；get=取当前风格与参考图；clear=清空 |
| `ips_generate` | apiz HTTP 生图执行：**按模型家族自动传对参考图参数**——GPT-Image 用 `reference_image_urls`、Nano Banana 用 `image_urls`；默认 `apiz/gpt-image-2.5-flare` + `quality=low`；参考图本地图/http 均可（自动传 CDN）；轮询超时**不重提交**（防重复扣费） |
| `ips_validate` | 结构校验（validate_prompt.py 的 JS 移植）：26 必需字段齐全性、类型红线、完整/部分双模式。**报告不拦截** |
| `ips_diff` | 冻结度自检：两份 JSON 展平叶子字段逐一比对，返回改动/冻结清单与冻结率 |
| `ips_presets` | 预设库：内置 9 套（内置只读）+ 用户自存预设 |
| `ips_history` | 生成历史查询与管理（模型/比例/参考图数/积分/耗时/成图路径） |

## 面板「提示词工作台」

侧栏入口，**只有三个页签**（没有提示词 JSON、没有参数表单——那些是 agent 的内部机制）：

- **出图工作台**（首屏）：上面两步向导；Step2 还提供「不改提示词直接出图」快速通道（描述作为附加要求直传模型）
- **风格库**：已保存风格的缩略图墙（风格名/概括/参考图），「用于生图」一键选中回工作台，「删除」管理
- **生成历史**：记录看板（积分/耗时/参数/成图缩略图）、删除、清空

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `apizApiKey` | 空 | apiz API Key；留空时也可环境变量 `APIZ_API_KEY`，或本机 `apiz auth login` 后开启 `apizUseCliAuth` |
| `apizUseCliAuth` | 关 | 复用本机 apiz CLI 登录态 |
| `defaultModel` | `apiz/gpt-image-2.5-flare` | 也支持 `service-inference/gemini-nano-banana-2.1` 等双家族模型 |
| `quality` | `low` | GPT-Image 五档：low(10 积分)/medium/high(64 积分)/xhigh/max |
| `apizBin` | `apiz` | CLI 路径（参考图上传走 CLI upload，免费） |
| `timeoutSeconds` | 900 | 生图轮询超时；超时不重提交 |

未配置 HTTP 通道时 `ips_generate` 会报错并指引改用 **apiz CLI 兜底**（命令模板见随包 skill `references/image-generation.md`）。

## 实测结论（上游沉淀，随包 skill 全文收录）

- **双模型兼容**：同一份结构化 JSON 被 GPT-Image 2.5 flare 与 Gemini Nano Banana 2.1 正确消费，画风/构图/主体均准确还原。
- **最小化修改不漂移**：只改主体字段（骑驴武将→诸葛亮坐大象，8 个字指令），26 个叶子字段中 15 个逐字冻结，两模型输出仍保持原漫画风——系列作品靠同一份 JSON 骨架换角色，画风不漂移。
- **参考图必须传回**：提示词源自参考图时，出图必须把原图作为风格参考传入——分析完就丢原图是实测 bug，画风还原度大幅下降。带参考图版连坐骑的「滑稽圆凸眼」都能继承。
- **参数名坑**：GPT-Image 只认 `reference_image_urls`（1-16 张），`image_url`/`image_urls` 均 400；Nano Banana 只认 `image_urls`（≤14 张，传入即改图模式）。
- **超时不重跑**：单张 2-9 分钟，`--wait` 超时后任务仍在服务端继续，重跑=重复扣费。

## 开发

```bash
npm install
node test/lib.test.mjs        # 33 个单测（离线，网络全 mock）
node scripts/selftest.mjs     # 包完整性 + 金标准 + 上游 python 校验器对齐
node scripts/api-test.mjs     # 面板 API 全路由
node scripts/client-smoke.mjs # 客户端模块冒烟
node scripts/live.mjs         # 真实出图（花 10 积分，可选）
```

## 来源

- 上游 skill：`image-prompt-studio`（提炼自 nano-banana-prompt-studio，PyQt6 桌面端 + Flask Web 端），感谢 [linux.do](https://linux.do) 社区。快照授权与范围见 `skills/image-prompt-studio/NOTICE.md`。
- apiz 生图适配器移植自同系列 `dsh-ecom-visual-copy`（GPT-Image 通道），本插件扩展了 Nano Banana 家族参数。

## License

MIT
