# 第二轮自检记录（2026-11-18）

> 对应 Issue 评论：继续；把上次列的待办逐项过一遍，已完成的在 Issue 里写明对应 PR 文件或测试；没做完的补完并说明原因。另外再走一遍全量自检，发现就修，走新 PR。
> 基线：`main` @ `e31a7bc`（PR #4 合并后）。
> 本轮分支：`agent/self-audit-fixes-round2/self-audit-fixes-ce66b52bdf13`。

## 1. 上一轮遗留项逐项结果

上一轮的完整清单见 [`self-audit-2026-11-18.md`](./self-audit-2026-11-18.md) 第 5 节。本轮结果：

| # | 上轮遗留项 | 本轮状态 | 对应实现 / 测试 |
|---|---|---|---|
| 1 | FR-OV-05 渠道桥接进程/健康端点检查 | **部分完成**：支持显式 `options.channels[].healthUrl`，2 秒超时、60 秒缓存、HTTP 非 2xx/超时降级为 `error`/`unknown` 并保留最后成功时间。不会自动猜测桥接进程；端点必须由用户显式配置。 | `lib/sources.js` `checkChannelHealth` / `buildChannels`；`scripts/smoke-fishtank.mjs` 的 `/health` 500、`/healthy` 200 和缓存断言 |
| 2 | FR-AU-05 规则启用/停用/严重度 UI | **已完成**：设置页有规则列表，可启用/停用、改严重度、改类别/类型、增删规则；后端 `normalizeRules` 校验 ID、正则、关键字与重复项，并应用到时间线、概览脱敏和分享导出。 | `lib/rules.js`、`lib/runtime.js`、`lib/audit.js`、`lib/migrate.js`、`src/client.jsx` SettingsTab；`scripts/smoke-host.mjs`、`scripts/smoke-runtime.mjs` |
| 3 | FR-CP-01 自动触发可配置 | **已完成**：`options.autoCheckpointRoles` 可按源选择 `diary`/`persona`/`memory`，设置页提供复选；非法角色被过滤/拒绝。 | `lib/sources.js`、`lib/runtime.js`、`src/client.jsx`；`scripts/smoke-dsh-fish.mjs`、`scripts/smoke-fishtank.mjs` |
| 4 | FR-MG-03 预检 DSH/鱼插件版本 | **部分完成**：导出包会为 `fishtank`/`dsh-fish` 写入插件要求；预检读取 profile 的 `node_modules/<pkg>/package.json` 版本并按 `range` 校验；DSH 版本仍只按包 manifest 声明检查。 | `lib/migrate.js` `exportPackage` / `readProfile` / `preflight` |
| 5 | FR-MG-04 / AC-MG-05 事务化导入 | **改进完成**：参考导入在替换前把旧副本改名为 `.previous-*`，成功后删除；失败回滚；启动时 `recover()` 会把中断留下的 `.previous-*` 恢复为目标目录。写入目标也先确认覆盖并保留安全检查点。 | `lib/migrate.js` `importPackage` / `recover`；`lib/runtime.js` 启动恢复；`scripts/smoke-runtime.mjs` |
| 6 | FR-DC-02 源目录可写性 | **已完成**：自检对每个文件源增加 `source.<id>.writable`；POSIX 用 `access(W_OK)`，Windows 显示 ACL 未知而不伪造结论。 | `lib/doctor.js`；`scripts/smoke-runtime.mjs` |
| 7 | FR-X-02 自检正文 i18n | **已完成**：自检的标题、证据、修复建议均带 `titleKey`/`evidenceKey`/`remediationKey` 和参数；客户端中文化，复制报告也走同一套文案。 | `lib/doctor.js`、`src/client.jsx` DoctorTab、`locale/{zh,en}.json`；截图见下文 |
| 8 | FR-X-04 键盘与焦点 | **已完成基础项**：标签页支持左右/Home/End，模态框有焦点陷阱与关闭后焦点恢复，输入/按钮有 `:focus-visible` 轮廓。未做完整的焦点顺序审计。 | `src/client.jsx` TABS / Modal / CSS |
| 9 | FR-X-08 日志轮转/稳定错误码 | **未完成**：API 错误码稳定；日志仍走 Host logger，没有独立轮转文件。原因：项目没有自己的长期日志写入层，轮转应由 Host/部署负责；本轮不引入第二个日志系统。 | — |
| 10 | FR-X-09 设置页可调整项 | **已完成主要项**：数据根目录、保留策略（4 项）、HTTP 超时/响应上限、规则列表、自动检查点角色都可编辑并保存。扫描上限仍通过源 `options` 配置，未做独立表单。 | `lib/runtime.js` `saveConfig` / `configuration`；`src/client.jsx` SettingsTab；`scripts/smoke-fishtank.mjs` |
| 11 | 技术方案 JSONL 行偏移增量索引 | **未完成**：当前按文件读取，单文件 16 MiB、单源 5000 条上限；真实数据 277 KB / 326 条，首屏和筛选均在毫秒级。偏移索引会引入缓存失效、部分行、追加写入竞态等复杂度；没有大文件证据前不做。 | — |
| 12 | 技术方案 `**` glob | **已完成**：`listMatchingFiles` 支持 `**`（含 `**/` 匹配零层目录），跳过符号链接并有深度/数量上限。 | `lib/util.js`；`scripts/smoke-host.mjs` |
| 13 | FR-X-01 配置 schema 版本 | **已完成基础项**：配置有 `schemaVersion: 1`，保存时写入；旧配置缺省按 1 处理。尚未实现未来版本的迁移链。 | `lib/runtime.js` `normalizeConfig` / `saveConfig` |
| 14 | 导入到已有同 ID 参考副本 | **已完成**：参考导入预检返回 `overwrite` 与 `reference-target-exists` 警告；未确认覆盖时拒绝；UI 显示二次确认。 | `lib/migrate.js`、`lib/runtime.js`、`lib/api.js`、`src/client.jsx`；`scripts/smoke-runtime.mjs` |

## 2. 本轮新发现并修复的 bug

1. **参考导入会静默覆盖已有副本**：`importPackage` 原来直接 `rm(target)` 再 `rename(staging,target)`，预检也不提示。现在预检返回 `overwrite`，未确认时返回 `import-overwrite-required`；替换改为 `.previous-*` 备份 + 失败回滚 + 启动恢复。
2. **自检缺少源目录可写性检查**：补 `source.<id>.writable`，Windows 明确显示 ACL 未解释。
3. **规则配置只存在代码里**：补配置化规则、校验、UI 和分享/概览脱敏的一致性。
4. **自动检查点角色不可配**：补 `autoCheckpointRoles` 覆盖与 UI。
5. **渠道健康度没有端点探测**：补 `healthUrl` 超时/缓存/降级，保留最后成功时间。
6. **自检正文全英文**：补结构化 i18n key 与客户端渲染。
7. **`readZip` 允许重复条目名**：重复条目可能导致清单与校验和指向不同内容；现在直接拒绝。
8. **设置页没有控制台级配置**：补 dataRoot、保留策略、HTTP 默认值、规则、触发角色。
9. **迁移包没有 dsh-fish 插件要求**：现在导出会写入 `@ssamurias/dsh-fish` 要求，预检读取已安装版本并校验范围。
10. **标签页/模态框键盘体验不足**：补方向键、焦点陷阱、焦点恢复、focus-visible。

## 3. 验证

- `npm test`：8 个 smoke 全部通过。
- `npm run test:real`：真实 `~/.dsh-fish` 复制目录，概览 day=3/stage=1/turns=35；时间线 326 条；基线/手动检查点 6 文件；45 个文件哈希不变。
- 时区矩阵：UTC、America/Los_Angeles、Asia/Shanghai、Pacific/Kiritimati 下 3 个核心 smoke 均通过。
- CI：`ubuntu-latest`、`windows-latest`、`macos-15-intel` 全绿。
- 截图（同一 `demo/dsh-fish` 数据、1280×900、浅色主题；前 = `e31a7bc`，后 = 本分支）：
  - 设置页：[前](./screenshots/self-audit-round2/before-settings.png) / [后](./screenshots/self-audit-round2/after-settings.png)
  - 规则区：[后](./screenshots/self-audit-round2/after-rules.png)
  - 环境自检：[前](./screenshots/self-audit-round2/before-doctor.png) / [后](./screenshots/self-audit-round2/after-doctor.png)

## 4. 仍未完成（明确原因）

- **日志轮转**：由 Host/部署负责，本项目没有独立日志层；引入第二个日志系统会超出插件职责。
- **JSONL 偏移索引**：当前上限与真实数据规模下无需；没有大文件证据前不增加缓存失效/并发复杂度。
- **DSH 版本自动检测**：预检只读取包 manifest 声明的 DSH 范围；当前环境没有稳定的 DSH 版本注入约定。
- **自定义规则的 ReDoS 分析**：已限制长度并校验可编译；没有引入完整正则静态分析器，避免误报和额外依赖。
- **完整焦点顺序审计**：已覆盖标签页/模态框/焦点可见，未做全页面逐控件键盘审计。
