# dsh-image-prompt-studio · 提示词工作台

结构化 JSON 提示词的 AI 生图工作台（dsh 插件，第 38 个）。用**结构化 JSON（26 个中文叶子字段）而非长段自然语言**控制 AI 生图，实现精准定制、模块化复用与系列作品一致性。**同一份 JSON 同时兼容 Nano Banana 与 GPT-Image 两个模型家族**（2026-10-14 实测），出图统一走 apiz。

一句话：复刻图片风格，模仿风格生图！

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-image-prompt-studio
```

## 四条路径（随包 skill `image-prompt-studio`）

| 用户意图 | 路径 |
|---|---|
| 描述一个想要的画面 / 要一份新提示词 | A：生成（26 字段结构化 JSON） |
| 拿着已有 JSON 说"改 XX / 换成 XX" | B：最小化修改（精准打击 + 逐字冻结） |
| 给了参考图，要仿照/反推提示词 | A + agent 读图分析（四维度：角色特征/场景环境/画面风格/构图镜头） |
| 提示词就绪，要实际出图 | C：出图执行（GPT-Image 默认 / Nano Banana 备选） |

对话里直接说「帮我把这个画面写成结构化提示词」「把提示词里的冬天改成夏天」「参考这张图生成提示词」「用这个提示词出图」即可触发。

## 五个工具

| 工具 | 职责 |
|---|---|
| `ips_validate` | 结构校验（validate_prompt.py 的 JS 移植）：26 必需字段齐全性、类型红线（材质真实度必须非空字符串数组、嵌套不可拍平）、完整/部分双模式。**报告不拦截** |
| `ips_diff` | 路径 B 冻结度自检：两份 JSON 展平叶子字段逐一比对，返回改动清单/冻结清单/冻结率。程序只做逐字一致性比对，「改动是否落在修改意图覆盖的节点上」归 agent 判断 |
| `ips_presets` | 预设库：内置 9 套（Q版/三国/宋代/线稿漫画/讽刺漫画/中秋星野系列，内置只读）+ 用户自存预设（「保存为预设」落地） |
| `ips_generate` | apiz HTTP 生图执行：JSON 原文作 prompt（可追加「特别要求：」）；参考图本地图/http 均可（自动传 CDN）；**按模型家族自动传对参数**——GPT-Image 用 `reference_image_urls`、Nano Banana 用 `image_urls`；默认 `apiz/gpt-image-2.5-flare` + `quality=low`（10 积分/张）；轮询超时**不重提交**（防重复扣费，拿 taskId 用 `apiz tasks get` 续取） |
| `ips_history` | 生成历史查询与管理（模型/比例/参考图数/积分/耗时/成图路径） |

## 面板「提示词工作台」

侧栏入口，四个页签：

- **预设库**：内置 9 套 + 用户预设浏览、一键加载进编辑器
- **提示词编辑**：JSON 编辑 + 结构校验（与 ips_validate 同引擎）+ 冻结度比对视图（改动字段表格 + 冻结率）+ 存为预设
- **出图**：模型/比例/质量/分辨率选择、参考图清单（每行一个本地路径或 http URL）、特别要求、异步任务进度、成图预览
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
