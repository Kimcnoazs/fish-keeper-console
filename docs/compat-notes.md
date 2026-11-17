# 目标鱼插件兼容笔记（M0 校准）

> 本文件记录对目标鱼插件 **dsh-fishtank** 的真实数据布局、字段与 HTTP 端点的校准结果。
> 结论来自已安装的插件源码，而不是猜测；样本文件见 [`demo/fishtank/fish.json`](../demo/fishtank/fish.json)。

## 1. 校准对象

| 项 | 值 |
|---|---|
| 插件包 | `dsh-fishtank@0.1.0` |
| 安装位置 | `%USERPROFILE%/.dsh/profiles/web/node_modules/dsh-fishtank` |
| Host 入口 | `index.js` |
| 数据实现 | `lib/fish.js` |
| 配置入口 | `cordis.patch.yml` → `config` |
| 浏览器端点 | `GET /fishtank/state`、`POST /fishtank/talk` |
| 工具入口 | `fishtank_talk`、`fishtank_status`、`fishtank_export`、`fishtank_import` |

## 2. 数据目录与文件

`lib/fish.js:97-98`：

```js
const dir = config.fishDir || join(homedir(), '.dsh', 'fishtank', String(config.id || 'default'))
const file = join(dir, 'fish.json')
```

- 默认目录：`~/.dsh/fishtank/default/`
- 唯一数据文件：`fish.json`
- 没有独立的 `diary/*.jsonl`、`river/*.jsonl`、`self.json` 或凭据目录。
- 插件把整份状态常驻内存，`flush()` 有防抖；运行期间外部改写 `fish.json` 可能被下一次保存覆盖。

## 3. `fish.json` 真实结构

`lib/fish.js:40-75` 的 `emptyState()` / `normalizeState()`：

```json
{
  "v": 1,
  "createdAt": 1762801200000,
  "mood": "安静",
  "energy": 0.64,
  "facts": [{ "text": "…", "when": "今天下午", "mood": "想知道", "why": "…", "at": 1762830000000 }],
  "people": { "主人": { "name": "主人", "warm": 0.82, "at": 1762830000000, "replied": 12 } },
  "whispers": [{ "text": "…", "at": 1762846800000 }],
  "reflections": [{ "text": "…", "at": 1762840000000 }],
  "diary": [{ "date": "2026-11-11", "text": "…" }],
  "self": { "text": "人格/自述", "at": 1762600000000 },
  "history": [{ "role": "user", "text": "…", "at": 1762846800000 }],
  "thought": { "day": "2026-11-11", "count": 2, "last": 1762839000000 },
  "reflect": { "day": "2026-11-11", "at": 1762840000000 }
}
```

要点：

- **日记在 `diary[]` 内**，条目只有 `{ date, text }`，`date` 是本地日期字符串，没有时间与时区。
- **私语在 `whispers[]`**，`{ text, at }`，`at` 是毫秒时间戳。
- **自省在 `reflections[]`**，`{ text, at }`。
- **对话在 `history[]`**，保留最近 60 条；不是日记，不进入审计时间线。
- **记忆在 `facts[]`**，**人格在 `self.text`**，二者都在同一个 `fish.json` 里。
- 没有公开/私有字段；插件本身把日记视为私有内容。

## 4. 字段映射（file 适配器，预设 `fishtank`）

| Fish Keeper 字段 | 来源 |
|---|---|
| `status.mood` | `fish.json.mood` |
| `status.energy` | `fish.json.energy` |
| `status.name` | `fish.json.self.name`（不存在时用数据源 `displayName`） |
| `status.lastActiveAt` | `history[].at` / `whispers[].at` / `reflections[].at` 的最大值；无则取最新日记日期 |
| `status.latestDiary` | `diary[]` 最后一条（`visibility = private`） |
| `status.latestWhisper` | `whispers[]` 最后一条 |
| `status.dataBytes` | `fish.json` 文件大小 |
| `status.channels` | 空（插件无渠道概念） |
| `timeline.diary.text` | `diary[].text` |
| `timeline.diary.time` | `diary[].date`（按本地日期解析） |
| `timeline.diary.visibility` | 固定 `private` |
| `timeline.external` | 空（插件没有外部事件） |
| `describe.identity` | `sha256("fishtank\0" + createdAt)`，可在导出/写回间比对同一只鱼 |

可用 `options.fieldMap` 覆盖（留空即用上表默认值）：

```yaml
options:
  preset: fishtank
  fieldMap:
    statusPath: fish.json
    diaryList: diary
    diaryText: text
    diaryTime: date
    whisperList: whispers
    mood: mood
    energy: energy
```

## 5. HTTP 端点校准

| 端点 | 方法 | 返回 | 用途 |
|---|---|---|---|
| `/fishtank/state` | GET | `view()`：mood、energy、createdAt、self、facts、people、whispers、reflections、diary、history | 状态 + 最近 3 条日记 |
| `/fishtank/talk` | POST `{ text, from }` | `talk()` 结果 | 说话（Fish Keeper 不调用） |

- 没有 `/diary`、`/events`、`/status` 路由。
- `view().diary` 只返回最近 **3** 条，`view().whispers` 返回最近 **5** 条。
- `view().history` 去掉了 `at`，因此 HTTP 模式无法用对话时间推断活跃时间；活跃时间回落到 `createdAt` 或最新日记日期。
- **两个路由都没有鉴权**。若未来通过反向代理加鉴权，可在数据源 `options.credentialKey` 指向一个 `api-key` 凭据记录；Host 会以 `Authorization: Bearer <key>` 发出请求，401/403 会显示为“凭据缺失或失效”。

HTTP 预设配置：

```yaml
- id: fishtank-http
  displayName: 目标鱼（HTTP）
  adapter: http
  location: 'http://127.0.0.1:3000'
  options:
    preset: fishtank
    # 可选：credentialKey: 'fishkeeper/gateway'
```

## 6. 回滚与写回评估

| 操作 | 结论 | 原因 |
|---|---|---|
| 读状态 / 日记 | 支持 | `fish.json` 可解析 |
| 检查点 | 支持，但**没有自动检查点** | 只有 `fish.json` 一个文件，角色是 `status`，不匹配自动触发角色（diary/persona/memory），避免每次保存都产生检查点 |
| 手动检查点 | 支持 | 快照整个 `fish.json` |
| 文件回滚 | 支持，属于**整状态回滚** | `fish.json` 是唯一文件；回滚会同时回退日记、记忆、人格与对话 |
| 迁移写回 | 支持（`import: true`） | 目标目录存在 `fish.json` 即可；写前备份、原子替换 |
| 外部事件 | 不支持 | 插件没有渠道/事件模型 |

**运行中写回的竞态**：dsh-fishtank 在内存中持有状态并防抖保存。控制台写回 `fish.json` 后，若插件仍在运行，下一次保存可能覆盖写回结果。正确做法是写回后重载/重启 `dsh-fishtank`；插件自带的 `fishtank_import` 工具可在运行中安全替换状态，但 Fish Keeper 不在鱼进程内，v1 仍采用“停插件 → 写文件 → 启插件”的运维约定。面板与 `describe.warnings` 都会提示这一点。

## 7. M0 样本

- 合成样本：[`demo/fishtank/fish.json`](../demo/fishtank/fish.json)
- 字段与真实 `normalizeState()` 一致，覆盖 4 条日记、3 条私语、2 条自省、6 条对话、3 条记忆、2 个关系。
- 冒烟测试会用这个样本断言：日记时间解析、私语映射、身份哈希、单文件检查点、写回。
- 若目标插件升级后改动字段，先更新本文件与样本，再改 `lib/sources.js` 的 `fishtankLayout()`。

---

## 8. dsh-fish（只读预设 `dsh-fish`）

> 本节依据 `@ssamurias/dsh-fish@1.0.3` 的公开源码与 [`demo/dsh-fish/`](../demo/dsh-fish/) 合成样本校准；控制台不修改该插件或其数据。

### 8.1 数据目录与文件

| 项 | 值 |
|---|---|
| 插件包 | `@ssamurias/dsh-fish@1.0.3` |
| 默认根目录 | `~/.dsh-fish`（可用 `DSH_FISH_HOME` 或 `~/.dsh-fish-location.json` 迁移指针覆盖） |
| 受跟踪文件 | `home.json`、`events.jsonl`、`diary/YYYY-MM-DD.md` |
| 不跟踪的派生文件 | `state.json`（由事件流重算）、`config.json`、`owner.json` |

- `events.jsonl`：只追加的唯一可信源；一行一条事件，行序即时间序。
- `home.json`：当前工作区/会话、`turns`（累计轮数）、`lastTurnAt` / `prevTurnAt`（最近两轮对话的毫秒时间戳）、`createdAt`、`wokeFor` 等。
- `diary/YYYY-MM-DD.md`：一天一个文件；同日多次写入以 `\n\n---\n\n` 接在文件末尾，文件名是本地日期。
- 日记正文不进入事件流；`state.json` 只是派生快照，控制台不把它当作状态源。

### 8.2 字段映射

| Fish Keeper 字段 | 来源 |
|---|---|
| `status.day` / `status.stage` | `events.jsonl` 中 `day >= 1` 的最大 `day` 事件（同一天取最大 `stage`）；`day: 0` 的系统事件不参与 |
| `status.turns` | `home.json.turns` |
| `status.lastTurnAt` | `home.json.lastTurnAt`（毫秒） |
| `status.lastActiveAt` | `lastTurnAt`、最新事件 `ts`、最新日记日期三者最大值 |
| `status.latestDiary` | 最新 `diary/YYYY-MM-DD.md` 的正文与文件名日期（`visibility = private`） |
| `status.dataBytes` | `home.json` + `events.jsonl` + 所有 `diary/*.md` |
| `timeline.diary` | 每个 `diary/*.md` 一条；`occurredAt` 取文件名日期，正文原文 |
| `timeline.external` | `events.jsonl` 中每条有正文的事件；携带 `eventType`、`day`、`stage`、`verdict` |
| `describe.identity` | `sha256("dsh-fish\0" + home.json.createdAt)` |

`options.fieldMap` 可覆盖 `statusPath`、`eventsPath`、`diaryPattern`，默认值分别是 `home.json`、`events.jsonl`、`diary/*.md`。

### 8.3 只读边界

- 本预设声明 `home.json`、`events.jsonl`、`diary/*.md` 全部 `restorable: false`，`capabilities.restore` 与 `capabilities.import` 都是 `false`。控制台只读取这些文件；检查点只记录哈希与大小。
- `events.jsonl` 是唯一可信源，即使后续提供回滚也不会改写。
- 控制台不读也不改 dsh-fish 的 `config.json` 或 `diary.visible`；它按文件读取日记，因此 dsh-fish 自己界面里是否展示日记不影响这里的读取结果。

### 8.4 样本与测试

- 合成样本：[`demo/dsh-fish/`](../demo/dsh-fish/)
- 冒烟测试：`node scripts/smoke-dsh-fish.mjs`。断言 Markdown 日记按文件名取日期、事件流 `type/day/stage/verdict`、`home.json` 的 `turns`/`lastTurnAt`、读取前后源目录哈希不变，并回归 `preset: fishtank`。
- 界面证据（深色主题、1280×900、同一 `demo/dsh-fish` 数据源；“前”为 0.1.1 的 Client bundle，“后”为本 PR 重新构建的 bundle）：
  - 总览：[前](./screenshots/dsh-fish-before-overview.png) / [后](./screenshots/dsh-fish-after-overview.png)
  - 时间线：[前](./screenshots/dsh-fish-before-timeline.png) / [后](./screenshots/dsh-fish-after-timeline.png)
  - 数据源设置：[前](./screenshots/dsh-fish-before-settings.png) / [后](./screenshots/dsh-fish-after-settings.png)

> 本文件是非官方兼容说明，不包含 `dsh-fishtank` 或 `dsh-fish` 的代码，也不代表其作者对本项目的背书。相关名称归其作者所有。
