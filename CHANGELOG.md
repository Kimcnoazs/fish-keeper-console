# Changelog

本文件记录 Fish Keeper Console 的版本变更。格式参考 Keep a Changelog，版本号遵循 SemVer。

## [Unreleased]

### 新增

- `dsh-fish` 只读数据源预设：读取 `home.json`（`turns`/`lastTurnAt`）、`events.jsonl` 事件流（`type`/`day`/`stage`/`verdict`）与 `diary/YYYY-MM-DD.md`；默认跳过 `meta`/`test` 系统记录，不写回、不回滚、不修改 dsh-fish 插件。
- 文件适配器新增 Markdown 日记支持（`diary/*.md`，日期取文件名）。
- 总览显示成长天数/阶段/轮数/最后对话时间；时间线显示事件类型、`verdict` 与事件所属天数/阶段。
- `scripts/smoke-dsh-fish.mjs`：dsh-fish 日记、事件流、`home.json`、只读性与 dsh-fishtank 回归。
- `scripts/smoke-real-dsh-fish.mjs`（`npm run test:real`）：可选的真实 `~/.dsh-fish` 复制目录端到端验证。
- 设置页：控制台数据根目录、保留策略、HTTP 超时/响应上限、自动检查点角色。
- 风险规则设置：启用/停用、严重度、类别、关键字/正则规则增删，后端校验并应用到时间线、脱敏与分享导出。
- 渠道健康端点：`options.channels[].healthUrl`，2 秒超时、60 秒缓存、保留最后成功时间。
- 环境自检：源目录可写性检查；标题/证据/修复建议 i18n；配置 schemaVersion。
- 迁移：参考导入覆盖确认、`.previous-*` 备份与启动恢复；dsh-fish/fishtank 插件要求与已安装版本校验。
- 文件匹配支持 `**` glob；ZIP 重复条目直接拒绝。
- `dsh-fish` 可选安全回滚：源配置 `options.allowRestore: true` 后按检查点恢复；执行前必须确认已停用 dsh-fish 插件，`events.jsonl`/`home.json` 最近 30 秒内变过则拒绝；写入前自动快照当前状态，`events.jsonl` 只截断或经确认后整文件替换，成功后提示可重新启用鱼插件。默认仍只读。
- CI 增加中文路径任务：临时目录使用 `中文目录/测试` 复制仓库并跑完整测试。

### 修复

- 测试脚本改用 `fileURLToPath` 解析仓库路径，修复仓库位于中文目录时因 URL 百分号编码导致 smoke 全部失败的问题。
- dsh-fish / dsh-fishtank 纯日期按本地时区解析，不再把日记显示成 UTC 午夜偏移后的时间，也不会让概览“最近活动”落到未来。
- dsh-fish 启动基线与手动检查点会记录所有受跟踪文件（包括只读哈希）；基线固定，不会被保留策略自动清掉。
- dsh-fish 自动检查点只跟随日记写入，`events.jsonl` 追加不再产生数百个哈希点。
- 只读降级的第二个实例不再创建/清理检查点目录；HTTP 源不再创建检查点管理器或锁。
- dsh-fish 长运行实例会重新展开 `diary/*.md`，新一天的日记无需重载插件即可出现在概览、时间线和检查点中。
- 损坏的状态 JSON 返回 `source-invalid`；无法解析的 JSONL 行计数并在时间线提示。
- 中文界面的警告、事件类型、检查点角色/操作、常见错误码改为走 locale；补总览空状态入口、时间线空状态、检查点空差异和 HTTP 源检查点过滤。
- 检查点 manifest 与迁移包的导出器版本改为读取 `package.json`，不再写死 0.1.0。

## [0.1.1] - 2026-11-11

仅文档与打包元数据，功能与 0.1.0 相同：刷新 npm 页面上的 README（安装说明、界面截图、npm 徽章）。Release 附件 zip 仍为 0.1.0 快照。

## [0.1.0] - 2026-11-11

首个公开版本。分发渠道：npm 包 [`dsh-fishkeeper@0.1.0`](https://www.npmjs.com/package/dsh-fishkeeper) 与 [Release 附件 zip](https://github.com/AiLunSin/fish-keeper-console/releases/download/v0.1.0/fish-keeper-console-0.1.0.zip)。

### 新增

- 多数据源只读总览：文件源（JSON/JSONL 自动识别）与 loopback HTTP 源。
- `fishtank` 预设：按 `dsh-fishtank@0.1.0` 的真实 `fish.json` 结构校准字段与 HTTP 端点。
- 审计时间线：日记与外部行为合并、分页、搜索、风险筛选、默认脱敏。
- 风险规则：邮箱、手机号、身份证校验位、银行卡 Luhn、地址、常见 API 密钥。
- 检查点：启动基线、手动检查点、diff、回滚、安全检查点、固定/删除、按源只读降级。
- 迁移：`.fishkeeper` 导出（full/share）、导入预检、参考导入，以及写入目标数据目录（备份、安全检查点、原子替换、身份校验、确认令牌）。
- 环境自检：数据目录、凭据权限、profile 依赖、插件运行时、`ffmpeg`、锁状态。
- 数据源设置面板：面板内新增/编辑/删除数据源，经 `configEditor` 持久化并自动重载。
- HTTP 源鉴权：`credentialKey` 指向 `api-key` 记录时附加 Bearer，401/403 明确提示。

### 已知限制

- 写回与回滚 `fish.json` 需要先停止 dsh-fishtank，避免其防抖保存覆盖外部写入。
- 真实 DSH 桌面壳内的视觉复核受本机 Web 端口鉴权限制；深浅色已在同源浏览器预览中检查。

[0.1.0]: https://github.com/AiLunSin/fish-keeper-console/releases/tag/v0.1.0
