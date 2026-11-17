# 全面自检记录（2026-11-18）

> 对应 Issue：全面自检：修复失效功能并排查 bug。
> 核对对象：`README.md`、`docs/compat-notes.md`、`docs/requirements.zh-CN.md`、`docs/technical-design.zh-CN.md` 与实际代码。
> 真实数据：本机 `C:/Users/admin/.dsh-fish`（dsh-fish 1.0.2 实际数据，仅本地读取，未提交）。

## 1. 验证方式

- `npm test`：8 个 smoke 脚本全部通过（Node 24.21.0，Windows）。
- 真实数据端到端：`node scripts/smoke-real-dsh-fish.mjs`。脚本先把真实目录复制到临时目录，再通过完整 `ConsoleRuntime` 读取，最后对比复制目录的递归 SHA-256；不向真实目录写入，也不打印日记/事件正文。
- 只读探针：`scripts/smoke-dsh-fish.mjs` 在启动、读取、时间线、手动检查点、分享导出、回滚预检期间拦截 `fs.promises` 的写入口（write/append/rename/rm/mkdir/chmod/utimes/unlink/truncate/copyFile/open 写模式），任何落到数据源目录的写入都会让测试失败。
- 界面证据：用临时 DSH Web profile 加载真实 Client bundle + 真实 Host runtime，数据为仓库内 `demo/dsh-fish/` 合成样本；同一场景、同一 1280×900 视口、同一浅色主题。截图见 [`docs/screenshots/self-audit/`](./screenshots/self-audit/)。

## 2. 真实数据结果

自检时本机 `C:/Users/admin/.dsh-fish` 的实际结果：

| 项 | 结果 |
|---|---|
| 概览 | day=3、stage=1、turns=35、lastTurnAt=`2026-11-17T19:42:21.618Z`、lastActiveAt=`2026-11-17T19:42:21.618Z` |
| 日记 | 4 个 `diary/YYYY-MM-DD.md`，按日期倒序；最新一篇日期为本地 `2026-11-18 00:00` |
| 时间线 | 326 条（4 条日记 + 322 条事件），分 2 页；`meta`/`test` 系统记录默认不进入时间线 |
| 只读 | 对复制目录的 45 个文件做递归哈希，运行前后完全一致 |
| 检查点 | 启动基线 1 个（固定），手动检查点包含 6 个受跟踪文件；全部 `restorable=false` |

修复前，概览的“最近活动”会显示为 `2026-11-18 08:00`（比“最后对话”还晚、且落在未来）；时间线把所有日记显示为当天 08:00。修复后，日记按本地日期解析，概览“最近活动”回到真实的最后对话时间。

控制台没有独立的“日记”页：日记在总览的“最近日记”和审计时间线的 `日记` 条目里展示；本次对“概览、时间线、日记”三处的验证分别指总览卡片、时间线条目和日记正文/日期渲染。

## 3. 已修复的问题

每项都给出：现象、根因、改法、验证。

### 3.1 dsh-fish / dsh-fishtank 的纯日期被当成 UTC 午夜

- **现象**：真实数据里 `diary/2026-11-18.md` 在时间线显示为 `2026/11/18 08:00:00`（东八区），概览“最近活动”显示为 `2026/11/18 08:00`，比“最后对话”还晚，甚至落在未来。
- **根因**：`parseTime()` 对 `YYYY-MM-DD` 使用 `new Date(value)`，按 UTC 午夜解析；dsh-fish 的文件名日期和 dsh-fishtank 的 `diary[].date` 都是本地日期。东八区因此偏移 8 小时，负时区还会把日期显示成前一天。
- **改法**：`lib/util.js` 的 `parseTime()` 对纯日期按本地时区构造 `new Date(y, m-1, d)`，并校验年月日合法；dsh-fish Markdown 日记、fishtank 内嵌日记、通用 Markdown 日记共用这条路径。
- **验证**：`smoke-dsh-fish.mjs` 用本地日期计算期望值；真实数据脚本断言每个日记条目为本地午夜；时间线截图从 `08:00:00` 变为 `00:00:00`。在东八区（数据与查看端同一时区）真实数据的 `lastActiveAt` 回到最后对话时间，不再落到未来。纯日期本身不带时区；如果数据目录与查看端处于不同时区，本地午夜可能仍显示为“未来”，这是日期语义的固有限制，脚本不做跨时区断言。

### 3.2 dsh-fish 没有启动基线，手动检查点可能为空

- **现象**：真实 `.dsh/fishkeeper/checkpoints/dsh-fish` 有数百个检查点，但没有一个 `baseline`；启动后立刻点“创建检查点”会报“没有可快照的内容”。
- **根因**：`CheckpointManager.createUnlocked()` 只有在文件已有内容快照（`before`）或哈希变化时才记录；dsh-fish 的文件全部 `restorable=false`，`baseline()` 先把哈希记为已知，随后 `ensureBaselineCheckpoint()` 认为“没有变化”而返回 null。手动检查点同样忽略了未变化的哈希文件。
- **改法**：手动/基线检查点（`snapshotCurrent: true`）对非可回滚文件也记录当前哈希；自动检查点仍只记录实际变化。基线标记为 `pinned`，不会被保留策略自动清掉；检查点 manifest 的 `tool.version` 改用 `package.json` 的 0.1.1，而不是写死的 0.1.0。
- **验证**：`smoke-dsh-fish.mjs` 断言 dsh-fish 启动后有固定基线、手动检查点包含全部受跟踪文件；真实数据确认基线 6 个文件、手动检查点 6 个文件；检查点截图从空列表变为“基线 / 已固定”。

### 3.3 dsh-fish 的 events.jsonl 每次追加都生成自动检查点

- **现象**：真实数据在约 8 小时内留下 200 个保留检查点、415 条索引记录，全部是 `events.jsonl` 的哈希，没有一条可回滚内容。
- **根因**：`events.jsonl` 在 dsh-fish 预设里是 `role=memory`，自动触发器对 `diary/persona/memory` 一视同仁；dsh-fish 每轮对话、每条 `meta` 记账都会追加事件，于是每次防抖都创建一个只有哈希的 manifest，并把基线挤出保留窗口。
- **改法**：适配器 describe 新增 `autoCheckpointRoles`。dsh-fish 只对 `diary` 自动触发；`events.jsonl` 的变化仍由启动基线和手动检查点记录哈希。文件监听与 15 秒对账也只看自动触发角色，避免每轮无意义地扫全量事件流。
- **验证**：`smoke-dsh-fish.mjs` 直接构造 dsh-fish 角色配置：只追加 `events.jsonl` 时 `create({kind:'auto'})` 返回 null，写日记后才生成 `trigger=diary` 的检查点。

### 3.4 只读降级实例仍会写检查点目录

- **现象**：第二个控制台实例发现锁被占用后进入“只读降级”，但启动时仍会创建检查点目录、清理超期 `.staging`，与 AC-CP-04“不创建检查点文件”不符。
- **根因**：`ConsoleRuntime.start()` 先执行 `manager.init()`（建目录、清 staging），之后才拿锁；`CheckpointManager.init()` 没有只读模式。
- **改法**：先拿锁，再按锁结果初始化。写实例执行完整 `init()`；只读实例执行 `init({readOnly:true})`，只 `loadManifests()` 读列表，不建目录、不清理、不建基线、不监听。HTTP 源不再创建检查点管理器或锁。
- **验证**：`smoke-lock.mjs` 在第一个实例启动后放入一个超过 1 小时的 `.staging` 哨兵文件，第二个只读实例启动后哨兵仍存在，检查点数量不变；`smoke-fishtank.mjs` 断言 HTTP 源没有 `checkpoints` 管理器、没有 `locks/http.lock`，API 返回 `checkpoints-unsupported`。

### 3.5 损坏的状态 JSON 被当成空数据

- **现象**：把 `fish.json` 写成半截 JSON 后，总览仍显示“正常”，只是情绪/日记为空；用户看不到数据源已经损坏。
- **根因**：`readJsonSafe()` 吞掉所有解析错误并返回 `undefined`，preset 状态读取直接把它当成空对象。
- **改法**：新增 `readJsonStrict()`：文件不存在仍返回 `undefined`（鱼可能还没写），存在但无法读取或 JSON 非法则抛出 `fishkeeper/source-invalid`。dsh-fish 的 `home.json`、fishtank 的 `fish.json`、通用文件源的 `status` 都走严格读取；所有 JSON/JSONL 读取会先去掉 Windows 编辑器常见的 UTF-8 BOM。
- **验证**：`smoke-fishtank.mjs` 构造坏 `fish.json`，断言该源状态为 error、错误码为 `source-invalid`，同一控制台里另一条正常鱼仍为 ok；`smoke-host.mjs` 给 `fish.json` 加 BOM 后仍能正常读取。

### 3.6 无法解析的 JSONL 行被静默丢弃

- **现象**：仓库文档要求“有 N 行无法解析”要显示；实际代码只跳过坏行，不计数。
- **根因**：`readRecords()` 的 `catch` 没有累计；`AuditService` 也没有返回解析错误数。
- **改法**：`readRecords()` 返回 `skipped`；日记/外部事件读取累加；时间线 API 返回 `parseErrors`；客户端在时间线顶部显示“有 N 行无法解析，已跳过；源文件未被修改”。
- **验证**：`smoke-host.mjs` 断言 `readDiary().skipped === 1`；`smoke-runtime.mjs` 断言 `runtime.timeline().parseErrors === 1`。

### 3.7 中英文混排：警告、事件类型、检查点角色和错误

- **现象**：中文界面里 dsh-fish 的只读警告是英文；时间线的事件类型直接显示 `comment`/`dream`/`revise`/`heard`/`utterance`/`seed`；检查点文件角色显示 `restorable`/`read-only`，回滚计划显示 `restore`/`skip`；Host 返回的错误消息也是英文。
- **根因**：这些文案来自 Host 端字符串或原始枚举，没有走 locale 文件；客户端只翻译了部分固定标签。
- **改法**：
  - 数据源 describe 增加 `warningCodes`（保留英文 `warnings` 作为兼容回退），客户端优先按 code 翻译。
  - 新增 `eventType.*` 翻译（seed/utterance/heard/dream/revise/comment/voice/ask/answer/meta/test/browse/watch）。
  - 新增 `checkpoints.role.*`、`checkpoints.action.*`、`checkpoints.readOnly/restorable/stale`。
  - 错误码映射到 `error.code.*`；未知错误码仍回退到 Host 消息。
- **验证**：截图对比中，概览警告由英文变为中文，时间线事件类型由原始英文变为中文，检查点详情角色/只读/回滚禁用说明均为中文。

### 3.8 其他界面与边界问题

- **时间线空状态**：无记录时正文错误地显示“部分数据源超过扫描上限”；现在只显示“没有匹配的记录”，截断/解析/部分源失败分别显示独立提示。
- **检查点空差异**：dsh-fish 的检查点没有可回滚文件时，详情区一直显示“选择一个检查点”；现在选择检查点后会显示“这个文件没有可预览的文本差异”。
- **检查点数据源过滤**：HTTP 源不支持检查点却出现在检查点下拉框并显示可点击的“创建检查点”；现在只列出 `capabilities.checkpoint !== false` 且未失败的源，只读源禁用创建/固定/删除。
- **空状态入口**：总览空状态只有 YAML 提示，没有文档承诺的“添加数据源”入口；现在增加“配置数据源”按钮，直接跳到“数据源设置”。
- **设置页预设**：HTTP 源可以选择 `dsh-fish` 预设但后端不会按该预设解析；现在 HTTP 源不显示该预设，切换适配器时自动移除。
- **检查点创建提示**：创建成功后的 toast 之前显示按钮文案“创建检查点”，现在显示“检查点已创建”。
- **Windows 权限文案**：渠道凭据详情在 Windows 上不再显示 `0666` 这种误导性 mode，改为“present (Windows ACL not interpreted)”。

### 3.9 长运行实例看不到新一天的日记

- **现象**：控制台在 11-17 晚间启动，dsh-fish 在 11-18 凌晨新建了 `diary/2026-11-18.md`；但如果只看启动时的适配器快照，这一篇不会出现在概览、时间线和检查点里，必须重载插件才能看到。
- **根因**：`dshFishLayout()` 在适配器创建时只展开一次 `diary/*.md`，`description.files`、时间线读取和检查点扫描都使用这份静态列表。
- **改法**：dsh-fish 每次 `readDiary()` / `describe()` 重新展开 `diary/*.md`；`CheckpointManager` 增加 `refresh` 回调，在基线、手动/自动检查点、15 秒对账前刷新受跟踪文件；监听器增加 `diary/*.md` 模式，新文件即使没有出现在启动列表里也会触发对账；迁移导出也重新取一次描述。
- **验证**：`smoke-dsh-fish.mjs` 在运行时启动后新建 `diary/2026-11-12.md`，断言概览立即显示新日记、时间线有 3 条日记、手动检查点包含 5 个文件，无需重载。

## 4. 只读承诺审计

对 `lib/` 的写入口逐项核对：

| 路径 | 是否写数据源 | 说明 |
|---|---|---|
| `sources.js` 全部读取 | 否 | 只有 `fs.read*`/`stat`/`readdir`/`realpath` |
| `runtime.overview/timeline/entry/doctor/export` | 否 | 只读源；写入只发生在 `dataRoot` |
| `CheckpointManager.init/baseline/create/list/diff` | 否 | 写 `dataRoot/checkpoints`；不写源 |
| `CheckpointManager.restore` | 仅 `restorable` 文件 | dsh-fish 全部 `false`，运行时直接拒绝 |
| `MigrationService.export` | 否 | 读源，写 `dataRoot/exports` |
| `MigrationService.importPackage`（reference） | 否 | 只写 `dataRoot/imports` |
| `MigrationService.writeBack` | 仅 `capabilities.import` | dsh-fish `false`，预检返回 blocked |
| `runtime.saveSources` | 否 | 只写 profile 配置，需用户显式保存 |
| 锁/心跳 | 否 | 只写 `dataRoot/locks` |

`smoke-dsh-fish.mjs` 的写入口探针覆盖启动、概览、时间线、回滚预检、手动检查点、分享导出；测试结束后复制源的递归哈希不变。真实数据脚本也做了同样的复制目录哈希对比。

## 5. 文档与实现仍不一致的地方（未在本 PR 全部实现）

以下差异保留为已知限制，已在 README / 需求单“实现状态”中标注，避免继续把设计写成已实现：

| 文档声明 | 实际状态 | 处理 |
|---|---|---|
| 需求单 FR-OV-05 渠道桥接进程/端点在线检查 | 只检查凭据文件、配置渠道和事件时间；不探测桥接进程/健康端点 | 记为已知限制 |
| 需求单 FR-AU-05 规则启用/停用/严重度 UI | 默认规则静态；主观规则默认关闭，无规则 UI | README 已有说明 |
| 需求单 FR-CP-01 触发器可配置 | 自动触发角色按预设固定；`options` 里未开放开关 | 记为已知限制 |
| 需求单 FR-MG-03 预检 DSH 版本/鱼插件版本 | 只在包 manifest 带 `compatibility.requires` 时检查；dsh-fish 包不带插件要求 | 记为已知限制 |
| 需求单 FR-MG-04/AC-MG-05 事务化导入 | 参考导入先解压到 staging 再替换；替换窗口不是崩溃原子 | 记为已知限制 |
| 需求单 FR-DC-02 源目录可写性 | 自检只检查控制台数据根目录，不逐个探测源目录 | 记为已知限制 |
| 需求单 FR-X-02 所有文案 i18n | 固定界面、警告、事件类型、检查点文案已中文化；环境自检的检查标题/证据仍是 Host 生成的英文 | 记为已知限制 |
| 需求单 FR-X-04 完整键盘/焦点管理 | 按钮、标签页可键盘操作；模态框没有焦点陷阱 | 记为已知限制 |
| 需求单 FR-X-08 日志轮转/稳定错误码 | API 已有稳定错误码；Host 日志没有独立轮转 | 记为已知限制 |
| 需求单 FR-X-09 设置页调整 dataRoot/保留策略/扫描上限/规则包/HTTP 超时 | 设置页只编辑数据源；dataRoot 在配置文件中设置 | 记为已知限制 |
| 技术方案 JSONL 行偏移增量索引 | 每次读取整文件；有 16 MiB 上限与条目上限 | 设计基线，未实现 |
| 技术方案 `**` glob | 文件匹配只支持单个 `*` | 设计基线，未实现 |

## 6. 测试与证据

- `npm test`：8 个 smoke 脚本通过。
- `node scripts/smoke-real-dsh-fish.mjs`：真实数据复制目录验证通过（概览 / 时间线 / 日记 / 基线 / 手动检查点 / 哈希不变）。
- `node --check lib/*.js`、`node --check scripts/*.mjs`：通过。
- 界面截图（同一 demo 数据、1280×900、浅色主题；前 = `main` @ `288d564`，后 = 本 PR）：
  - 概览：[前](./screenshots/self-audit/before-overview.png) / [后](./screenshots/self-audit/after-overview.png)
  - 时间线：[前](./screenshots/self-audit/before-timeline.png) / [后](./screenshots/self-audit/after-timeline.png)
  - 检查点：[前](./screenshots/self-audit/before-checkpoints.png) / [后](./screenshots/self-audit/after-checkpoints.png) / [后-详情](./screenshots/self-audit/after-checkpoint-detail.png)
