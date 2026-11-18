# NOTICE · image-prompt-studio skill 快照来源

本目录是上游 skill 包「image-prompt-studio」的随插件快照，用于 dsh 插件 `dsh-image-prompt-studio`。

- 上游：本地项目 `D:\dsh-research\资料\image-prompt-studio-main`（SKILL.md + references + scripts/validate_prompt.py + 9 套预设）。
- 上游自述来源：`nano-banana-prompt-studio`（PyQt6 桌面端 + Flask Web 端，提示词工程知识提炼为 agent skill），感谢 https://linux.do 社区。
- 快照范围：`references/*.md`（prompt-schema / system-prompts / options-library / image-generation 四份）与 `assets/presets/*.json`（9 套）**原样收录**；`SKILL.md` 按 dsh 插件形态改写（校验改用 ips_validate 工具、冻结比对改用 ips_diff、生图优先 ips_generate 工具、apiz CLI 兜底）；`scripts/validate_prompt.py` 已移植为插件 `lib/check.js` 的 JS 内核，快照里不再保留。
- 快照文件不做上游同步（不 git pull / 不 npm install），随插件版本一起演进。
