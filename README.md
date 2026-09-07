# api-usage-board — AI API 用量监控 Dashboard

深/浅双主题监控台，监控 **8 个渠道**：Claude Code / Codex / Kimi Code / DeepSeek /
OpenRouter / Grok / Cursor / Antigravity。前端 vanilla HTML/CSS/JS（ES modules），
无构建步骤、无外部依赖、无 CDN；本地 server（`server/server.mjs`）只用 Node 内置模块，
零 npm 依赖。数据全部为真实来源（mock 仅作 server 不在时的兜底，且会自动切回）。

> 产品原型及 UI 借鉴自公众号「杂谈by立行」文章
> [《人生的塞尔达时期：日均40亿Token的那一周》](https://mp.weixin.qq.com/s/9IQzxijlbDdLiAiS8np5aQ)，
> 供开发学习和自用。

## 快速开始

**1. 前置条件**：Node ≥18。

**2. 克隆并启动**：

```bash
git clone https://github.com/isalicema/api-usage-board.git
cd api-usage-board
./serve.command
```

## 运行

推荐常驻方式：**双击 `serve.command`**（或终端 `./serve.command`）——起 `server/server.mjs`
（静态文件 + `/api/*`，仅绑 127.0.0.1:8177），轮询 `/api/health` 就绪后再开浏览器
（首轮大日志扫描要十几秒，直接开会看到 mock 兜底）。若服务已在跑则只打开页面，不重复起。
**服务开着就别关**，改代码后浏览器刷新即生效（如遇缓存用 ⌘⇧R 强刷）。

**快捷指令（macOS 快捷指令 App）**：新建快捷指令 →「运行 Shell 脚本」操作，内容：

```bash
nohup "/path/to/api-usage-board/serve.command" >/dev/null 2>&1 &
```

必须 `nohup ... &` 后台化：快捷指令会等脚本退出才算完成，`serve.command` 里的 server 是
常驻前台进程，不后台化的话快捷指令会一直转圈、且脚本被回收时 server 也会被带走。
（可选）把该快捷指令加到登录项实现开机自启。

node 探测顺序：`command -v node` → `~/.nvm/nvm.sh` → `~/.nvm/versions/node/*/bin/node` 取最新
（双击/快捷指令的 shell 不加载 nvm；已用 `env -i HOME="$HOME" bash serve.command` 实测通过，
会落到 `/usr/local/bin/node` v22，server 兼容 Node ≥18）。

URL 参数：`?poll=5` 覆盖轮询间隔（默认 30 秒，单位秒，下限 2）。

## 功能全景

**Dashboard tab（配额）**
- 告警横幅由配额数据自动推导：用量 ≥95% → 红「已用尽」；按窗口内线性烧速外推 24h 内用尽
  （且用尽点在窗口重置之前）→ 黄「约 Xh 后用尽」；offline → 红 OFFLINE。
  dormant / unconfigured 渠道永不进横幅。
- 每渠道配额进度条：颜色按用量分档（<50% 绿 / 50–85% 橙 / >85% 红）；**白色竖线 = 窗口时间进度，
  用量超过竖线 = 消耗快于时间节奏**（面板内有图例）；竖线每秒平滑推进（fetch 锚定 + 本地插值，
  stale 渠道照推）。右侧重置倒计时每秒本地递减。
- 状态语义：ONLINE（绿）/ STALE（黄，查询失败但有 ≤30min 旧快照，副标「数据为 N 分钟前 ·
  查询失败重试中」）/ OFFLINE（红）/ NO KEY（灰，未配置）/ 未运行（灰，dormant，如 agy 没在跑）。
- 订阅标签：Claude「Pro 订阅」、Codex「pro 订阅」等来自凭证/接口的 plan 字段。

**Token 用量 tab**
- 今日概览（一排四张数值卡：今日总处理/权威量 + input/output/cache 拆分 + 昨日与 7 日均值对照；
  累计 Token 历史总计含统计起始日与活跃天数、单日峰值含峰值日期与占比——后两项从一年
  热力图序列推导，固定含 cache 口径，覆盖范围 = 本地扫描窗口）。
- **每个面板均可折叠**（面板头右侧 chevron 按钮，grid-rows 抽屉动画）；折叠态持久化在
  localStorage `aub:panel-collapsed`，跨会话保持——截图时可以把不看的卡片收成抽屉。
- 每日用量热力图（GitHub/Codex 风格**一年视图**：周一起始、52 周 + 2 未来列（虚线空格区分）、
  格子 flex 均分铺满面板宽、月份标签在底部、固定「含 cache」口径与范围选择器解耦；
  **平方根刻度 6 档**（`1+min(4, floor(√(v/max)×5))`，色阶 12%→100%——log 刻度会把高端压平，
  实测 2.3/5.6/11.7 亿同档，sqrt 后分落 3/4/5 档）；hover 浮标看当天总量，空格显示
  「无数据（0）」——扫描窗口之前的日子语义上就是 0）。
- 趋势堆叠图（手绘 canvas，无图表库）：今日/昨日/近3日/近7日/近30日 × 口径（含/不含 cache）联动；
  **hover 柱子出浮标**（日期 + 总量 + 各渠道分项按量降序，数值口径跟随当前切换）。
- Coding Agent / 模型 / 项目三面板：横条+数值+百分比，top 6 +「其他 N 项」抽屉（点击展开全部明细，
  比例基准与主列表一致）；项目面板 hover 显示完整路径。
- 项目别名归并：`server/config.json` 的 `projectAliases`（mtime 热加载），合并行带
  「已合并 N 个目录」标记。
- 费用预估与套餐回报：刊例价折算等效 API 费用 vs 订阅月付 → ROI 倍数；多币种（CNY 按
  `cnyUsdRate` 折算）；OpenRouter 用真实花费。**刊例价为占位，待核实**（见下文配置节）。

**通用**
- **渠道图标**：8 渠道各有内联 SVG 手绘字形 + 品牌色圆角 tile（Claude 星芒 #d97757 /
  Codex 终端符 #10a37f / Kimi 弯月 #7c6cff / DeepSeek 鲸鱼 #4d6bfe / OpenRouter 环路箭头 /
  Grok X 与 Cursor 指针为黑白标随主题墨色 / Antigravity 四角星 #8ab4f8），零外部资源。
  出现在 Dashboard 渠道区块与 API 状态行、Token tab 的 Coding Agent 面板与费用面板。
- **一键分享**（标题行右侧分享图标）：canvas 手绘 1200 宽分享卡（2x 输出 PNG），**卡面跟随
  页面主题**（dark=深靛夜空 / light=淡薰衣草极光，与页面同色系）——标题酸橙标记 +
  今日概览四数值 + 一年热力图（与页面同口径）+ **渠道图标行（在线点亮、未激活压暗）** + 版权页脚。
  弹层预览后可选：保存 PNG（`multi-ai-usage-YYYY-MM-DD.png`）/ 复制图片到剪贴板 /
  系统分享（`navigator.share` 文件分享，不支持时按钮自动隐藏）。无外部依赖，不走 DOM 截图
  （玻璃拟态 backdrop-filter 无法被 DOM 序列化捕获，手绘 canvas 反而像素级可控）。
- 深/浅主题切换（标题行右侧按钮，localStorage 持久化，首次跟随系统，浅色状态色已调色保对比度）。
- server 没起时前端回退 MockSource + 显示「MOCK 数据」pill，且每 15s 自动重试切回真实源。
- localStorage 历史：`aub:quota-history` / `aub:token-history`，按天聚合 cap 90 天（真实快照）。

## 配置文件

| 文件 | 内容 | 说明 |
|---|---|---|
| `server/.env` | `OPENROUTER_MANAGEMENT_KEY=sk-or-...` | OpenRouter key（600 权限）。⚠️ 早期误存的 `server/.env.rtf`（富文本）仍在目录里，确认 `.env` 生效后请手动删除 |
| `server/config.json` | `projectAliases` / `modelPrices` / `subscriptions` / `cnyUsdRate` | 全部 mtime 热加载，改完不用重启。刊例价与套餐金额是占位/自述值，按实际改 |

## 数据架构（真实数据）

```
~/.claude/projects/*.jsonl（本地扫描）+ api.anthropic.com/api/oauth/usage ─┐
~/.codex/sessions/**/rollout-*.jsonl + chatgpt.com/backend-api/wham/usage ─┤
~/.kimi-code/{credentials,sessions,session_index.jsonl} + coding/v1/usages ─┤
api.deepseek.com/user/balance + ~/.dsh/sessions/**.zstd ────────────────────┤
openrouter.ai /credits + /analytics/query（management key）─────────────────┤
cli-chat-proxy.grok.com/v1/billing + ~/.grok/{sessions,logs} ───────────────┤   server/adapters/*.mjs
Cursor state.vscdb + api2.cursor.sh DashboardService ───────────────────────┤   （TTL 缓存 + stale 降级，
agy 本地 language server RetrieveUserQuotaSummary ──────────────────────────┘    单渠道失败不拖垮整包）
        ↓
server/server.mjs —— 127.0.0.1:8177：静态托管 + /api/{health,quota,status,token-series,by-project,cost-summary}
        ↓
real-source.js createHttpSource('/api')  ←→  与 MockSource 同接口
        ↓
usage-board.js（store + 轮询 + 告警推导 + localStorage 历史 + 渲染）
```

前端默认走 HttpSource。`window.__board = { state, refresh, switchTab, setTheme }` 供调试。

### 八渠道来源与字段对照

| 渠道 | 配额 | Token 序列 |
|---|---|---|
| Claude Code | **官方直连（主）**：`GET https://api.anthropic.com/api/oauth/usage`（需 `anthropic-beta: oauth-2025-04-20` 头，少了 401；未公开接口，跟随官方客户端行为，可能漂移）。凭证：env `CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → Keychain（`Claude Code-credentials`，hex 先解码）。**回退（辅）**：ccusage blocks/daily 估算（副标注明「限额为 ccusage 估算」）。都不通 → offline。不做 token 刷新写回（与 CLI 并发写回有 refresh_token 轮换冲突风险），仅 401 重读凭证重试一次。plan 标签来自 `subscriptionType` | **本地增量扫描** `~/.claude/projects/*/*.jsonl`：`type=="assistant"` 记录的 `message.usage`（input/output/cache_read/cache_creation），按 `message.id` 去重（流式分片重复），过滤 `model=="<synthetic>"`，cwd 取记录 `cwd` 字段（按项目统计需要，ccusage daily 无 cwd 故弃用作序列源）。**历史回补**：2 月数据来自 `server/data/claude-feb-backfill.json`（源 `~/.claude/stats-cache.json`，2026-08-25 导入，行标 `bf:1` 不被 95 天窗口裁剪） |
| Codex | **官方直连（主）**：`GET https://chatgpt.com/backend-api/wham/usage`（headers：`originator: Codex Desktop`、`OAI-Product-Sku: CODEX`、可选 `ChatGPT-Account-Id`；未公开接口，可能漂移）。凭证：`~/.codex/auth.json` 的 `tokens.access_token`，account_id 取不到就从 JWT claim 解。窗口 ≤12h→5小时，否则→7天。**回退（辅）**：rollout jsonl 尾部 `rate_limits`。不刷新 token | rollout jsonl 的 `token_count` 事件 `payload.info.last_token_usage`（turn 增量；cached ⊂ input，权威量=input−cached+output）；model/cwd 取 `turn_context` 事件 |
| Kimi Code | `GET https://api.kimi.com/coding/v1/usages`（注意是 `/usages` 复数，单数 404）。`limits[]` 里 300 分钟窗口=5小时，顶层 `usage`=7天。Bearer 读 `~/.kimi-code/credentials/kimi-code.json`（每次现读）。token 15 分钟过期：401 时重读凭证立即重试一次（轮换间隙），失败走 stale（≤30min 旧快照）；CLI 长期不跑则彻底失鲜（见遗留）。offline 必带原因 note（2026-08-20）：401 → 「登录态已过期（token 15 分钟有效），打开一次 Kimi Code 即自动刷新」；无凭证区分未安装/未登录 | `session_index.jsonl` → `agents/*/wire.jsonl` 里 `usage.record` + `usageScope=="turn"`（`session` 是累计快照，勿重复计）；cwd 取 session 的 `workDir` |
| DeepSeek | `GET https://api.deepseek.com/user/balance`，key 手解 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` 行（不引 yaml 库） | `~/.dsh/sessions/**/session.jsonl.zstd`（`zstd -dc`），`chunk.type=="usage"`；cwd 从目录名 best-effort 解码；用量少、序列稀疏是正常的 |
| OpenRouter | `GET /api/v1/credits`（余额 = total_credits − total_usage）+ `GET /api/v1/auth/key`（key 类型检测：`is_management_key`）。key 配置：`server/.env`（优先）或环境变量，变量名 `OPENROUTER_API_KEY` / `OPENROUTER_MANAGEMENT_KEY` 都认；未配置降级为 NO KEY | **analytics 系列需 management key**（Settings → Management Keys 创建，只读、不能发推理；普通 key 调 403）。序列用 `POST /api/v1/analytics/query`（一次拿 45 天；`time_range` 必须完整 ISO datetime；响应 `data.data[]`，count 类指标是字符串要 `Number()` 防御解析；beta 接口注意漂移）。失败回退磁盘快照 `server/.cache/openrouter-analytics.json`；/activity 逐日方案为备选。花费为真实 USD。无项目维度（by-project 明确排除） |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（Bearer = `~/.grok/auth.json` entry.key JWT；**只读不刷新**，xAI 轮换 refresh token 会互顶）。**注意：`creditUsagePercent` 是付费 credit 用量字段，free 用户恒省略**——free 额度（滚动 24h，500k tok）接口不暴露，唯一信号是推理 429 报错文本（`subscription:free-usage-exhausted`，内含 `tokens (actual/limit): A/L`），从 `unified.jsonl` 尾部解析：24h 内有用尽事件 → 按 A/L 显示（用尽即 100%）；无事件 → 暂缺并注明「以客户端提示为准」。兜底：`unified.jsonl` 最新「billing: fetched credits config」。**offline 必带原因 note**（2026-08-20）：无 `~/.grok` → 未安装；有目录无凭证 → 未登录；401/403 → 凭证已过期提示重登（重登后 gate 自动恢复）；其余 → 接口不可达 | `~/.grok/sessions/*/*/updates.jsonl` 的 `params._meta.totalTokens`。**语义实测：上下文体积快照**（轮内流式递增、跨轮回落，非单调）——近似口径：回落点为轮边界取末值求和，EOF 在途轮增量入账，量级正确但非精确计量 |
| Cursor | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`（Connect 协议，body `{}`）。凭证：`state.vscdb`（WAL，**复制到临时目录再只读打开**，node:sqlite 优先 / sqlite3 CLI 兜底）的 `cursorAuth/accessToken` + `stripeMembershipType` 做订阅标签。月账期花费制 → 「月账期」窗口（`totalPercentUsed`）。401/403 → offline + 「凭证过期，重新打开 Cursor 登录」 | **无**（本地无干净日志，`tokenData:false`，不进 Token tab） |
| Antigravity | **凭证未定位**（旧路径失效），云端走不通。机会主义采集：agy 运行时从最新 `cli-*.log` 正则 language server 端口，POST `RetrieveUserQuotaSummary`（500ms 逐个试）。响应是 **remaining**Fraction（已用=1−remaining）。**响应按模型分两组**（Gemini Models / Claude and GPT models），各有独立 weekly+5h 池——标签必须带组前缀（`Gemini 7天` / `Claude/GPT 5小时`），否则 UI 出现两行同名窗口且倒计时键冲突（2026-08-20 修）。agy 不在跑 → `dormant`（灰 pill「未运行」，永不进告警横幅、不计入同步分母），有 ≤24h 旧快照则显示旧数据+采集时间 | **无**（`tokenData:false`） |

### 项目维度（GET /api/by-project）

按工作目录聚合 token 用量（Token tab「项目」面板）。各渠道 cwd 来源见上表。
扫描缓存结构 v2（rows 带 cwd），旧缓存自动全量重建（首轮慢一次）。

**项目别名归并**：`server/config.json` 的 `projectAliases: { 被归并路径: 目标路径 }`，
by-project 聚合时在 server 端合并（tokens 与 byChannel 都并入目标行）；被合并的行带
`mergedFrom`（全部源路径），前端项目名旁显示「已合并 N 个目录」标记，hover 列出源路径。
配置按 mtime 热加载。示例：`Documents/my-project-typo`（改名前的 typo 目录）→ `Projects/my-project`。

### 费用预估与套餐回报（GET /api/cost-summary?days=N）

按 模型×token类型 用刊例价折算等效 API 费用，与订阅月付对比出回报率（ROI）。
配置在 `server/config.json`（mtime 热加载）：

- `modelPrices`：美元/百万 tokens，模型名前缀最长匹配；`_default` 为未匹配模型的兜底价
  （渠道估值带 `~` 标记）。**⚠️ 全部是占位刊例价——榜单里的未来型号（claude-opus-5、
  gpt-5.6-sol、kimi-code/k3 等）真实价格未公布，数值仅为合理量级，请按官方价格页核实后改**。
- `subscriptions`：当前为真实值——Claude Pro $20、Codex Pro $200、Kimi 会员 ¥199/月、
  Grok/Cursor 免费档 $0；每项带 `currency`（USD/CNY），ROI 统一按 `cnyUsdRate`（默认 7.2）
  折算美元口径，订阅行按原币种显示。

口径：input（未命中缓存部分）× input 价 + cacheRead × cacheRead 价 + cacheWrite × cacheWrite 价
+ output（含 reasoning）× output 价；ROI = 等效费用 ÷（月付折算 × days/30）。OpenRouter 用真实花费
（total_usage USD，非估算）；DeepSeek 为按量计费（实付以余额扣减 CNY 为准）；Grok 是近似口径
（上下文快照）。免费档 ROI 显示 ∞。

### 调研备忘：社区共识

为 Coding Agent 补监控面板的同路数项目不少，结论一致：这些「未公开接口」是事实标准做法——
QuotaDot（`Services/ClaudeDirectClient.swift` / `CodexDirectClient.swift`，本模块 Claude/Codex
直连的出处）、CodexIsland、aiquokka、llmquota 等都是读本地凭证 + 调客户端同款端点。
Grok 的 `cli-chat-proxy.grok.com/v1/billing` 与 Cursor 的 `aiserver.v1.DashboardService`
亦出自该圈子的抓包/逆向共享。共同风险：接口随时漂移，所以每个渠道都必须有降级链。

### 缓存与性能

- 每渠道 SWR 缓存：quota 60s；token 序列 5–10min；ccusage 10min。过期先返旧数据、后台异步
  刷新；server 启动即后台预热。配额查询统一走 `staleGate`（ttl.mjs）：失败保留 ≤30min 旧快照
  降级 stale，超阈值 offline。
- codex/kimi/claude/grok 日志做**增量扫描**：按 path+size 记录解析 offset，持久化到
  `server/.cache/*.json`，滚动保留 45 天聚合。codex 单文件最大 500M+，分块（16MB）读取
  （`server/scan-util.mjs`），首轮全量扫约十几秒，之后毫秒级。
- 已知妥协：增量扫描仍是同步 fs，首轮会短暂阻塞 server 事件循环（预热期间 API 无响应，
  秒级~十几秒，仅首次）。后续如需可改 worker_threads。

### 安全约定

- key/token 只进 server 进程内存，绝不出现在 API 响应、日志、前端、probe 输出。
- server 只绑 127.0.0.1；`/api/*` 500 不透出错误细节；静态服务禁 `server/`、`_probe/`、
  `node_modules/` 及一切 dotfile 路径（`server/.env` 经 HTTP 不可读）。
- probe 含「页面/console 无 sk- / sk-or- / sk-ant- / eyJ（JWT）」泄露断言。

### 其他

- MockSource（`mock-data.js`）保留作兜底：mulberry32 固定种子，首屏稳定。

## 主题机制（dark / light）

- 视觉风格为 **Aurora（极光信号场）**：移植自 `ai-founder-signals-lab` 的设计语言——
  漂移极光背景团（4 团 blur 80px 渐变色，46–64s 缓动，`prefers-reduced-motion` 静止）、
  玻璃拟态面板（半透明底 + `backdrop-filter: blur(18px) saturate(1.3)` + 分层软投影）、
  长春花蓝主色（浅 `#4c5df5` / 深 `#7280ff`）、Yandex 式荧光酸橙标记
  （`--lime #d7f34f`：h1 末词色块微倾 + 面板标题荧光笔下划线）。浅色=淡薰衣草 `#f2f3fa`
  极光，深色=深靛夜空 `#090b16` + 同色系暗辉光。
  字体用 macOS 自带的 Avenir Next（lab 的 Bricolage Grotesque 走 Google Fonts，
  违反本模块「无 CDN」约定，未引）。
- 所有随主题变的颜色都是 CSS 变量，`:root` 定义 dark（默认），`[data-theme="light"]` 覆盖浅色一套
- 切换入口：标题行右侧太阳/月亮按钮（`.theme-toggle`）；选择持久化在 localStorage `aub:theme`，
  首次访问跟随 `prefers-color-scheme`。
- 首帧防闪烁：`index.html` 里有一段内联脚本在 CSS 加载前给 `<html>` 写 `data-theme`；
  `usage-board.js` 的 `setTheme()` 只负责交互切换 + 重绘 canvas（图表网格/坐标轴色
  由 `getComputedStyle` 读 `--chart-grid` / `--chart-axis`，切主题必须重绘）。
- probe 侧可用 `window.__board.setTheme('light'|'dark')` 切换。
- 浅色状态色调色记录（2026-08-19，用户反馈浅色下红太刺眼）：红 `#dc2626 → #b0453c`（砖红），
  绿 `#16a34a → #3d7a57`（灰调鼠尾草）；衍生 pill/chip 边框底色 rgba 同步换色相
  （`rgba(176,69,60,*)` / `rgba(61,122,87,*)`），告警横幅边框 `--alert-border` 同步。
  白底对比度：红 ≈5.4:1、绿 ≈5.1:1（均在 4.5:1 之上）。黄/蓝/橙与深色主题未动。

## 验证（probe）

验证脚本（需先 `ln -sfn ../qa-prod/node_modules node_modules`）：

```bash
node _probe/shots.mjs
```

服务策略：先探测 8177（serve.command 的常驻端口）——已在跑就**复用且跑完不停**；
8177 空闲才自起临时 node server（PORT=8179），跑完自动停。开着 serve.command 时随便跑 probe，
不会动你的服务。

probe 断言覆盖：8 渠道配额真实性与 source（Claude=direct / Codex=wham）、dormant/NO KEY 合法态、
tokenData:false 渠道不进 Token tab、by-project 非空 + 别名归并 + 归并标记、cost-summary 数值合法
（OpenRouter 真实花费、codex 内部一致性）、模型/项目抽屉展开收起、里程碑累计/峰值非占位含日期、
面板折叠（grid 行高归零 + localStorage 持久化 + 展开恢复）、时间刻度竖线平滑推进
（3s 实测增量 ≈0.017%）、三渠道 stale 构造降级（8180 独立实例 + `AUB_TEST_*_FAIL_AFTER` 钩子）、
无 MOCK pill、无密钥泄露、canvas 已绘制、告警 DOM 与 state 一致、控制台无报错。
hover 浮标断言前须 scrollIntoView（今日概览一排四卡后页面变长，趋势图在首屏以下，视口外坐标 mouse.move 无效）。

## Changelog

- 2026-09-07（八）：渠道图标。`CH_ICONS` 内联 SVG 手绘字形 + 品牌色 tile（`chIcon()`），
  接入 Dashboard 渠道区块 / API 状态行 / Coding Agent 面板 / 费用面板；分享卡右上新增
  渠道图标行（quota online/stale 点亮，其余 28% 压暗），`drawShareCard()` 改 async
  （SVG 字形经 data URL 烘焙成位图再 drawImage，按 颜色 缓存）。卡面高度 1162→1210。
- 2026-09-07（七）：分享卡面跟随页面主题——`drawShareCard()` 颜色抽成双主题调色板
  （dark 深靛夜空 / light 淡薰衣草极光，热力图格子、数值卡、文字色全套对应），
  浅色分享出浅色卡。probe 导出 share-card.png / share-card-light.png 双原图目检。
- 2026-09-07（六）：一键分享。标题行右侧分享按钮 → canvas 手绘分享卡（固定深靛极光卡面，
  今日概览四数值 + 一年热力图 + machiwhale studio 版权页脚，2x PNG），弹层内
  保存/复制/系统分享。里程碑计算抽为 `computeMilestone()` 与渲染共用。probe 新增
  分享卡绘制像素断言 + 弹层开关断言，并导出 `shots/share-card.png` 原图供目检。
- 2026-09-07（五）：页面底部加版权页脚「© 2026 machiwhale studio」（链接 https://machiwhale.com，
  新窗口打开，hover 变主色）。
- 2026-09-07（四）：UI 换 Aurora 风格（移植 ai-founder-signals-lab 的设计语言，双主题适配）——
  极光背景层（`.aurora` 四团漂移渐变色，深色为同色系暗辉光）、面板玻璃拟态
  （半透明 + backdrop blur + 分层软投影，圆角 12→16）、主色 #3b82f6/#2563eb → 长春花蓝
  `#7280ff`/`#4c5df5`、h1 末词酸橙色块微倾 + 面板标题荧光笔标记、正文字体换 Avenir Next
  （Bricolage Grotesque 需 Google Fonts，违反无 CDN 约定未引）。probe 修复一处 hover 竞态：
  scrollIntoView 的异步 scroll 事件会 hideTip，mousemove 需等 250ms 后补一次微移。
- 2026-09-07（三）：今日概览四卡由 2×2 改一排四列。数值字号默认保持 30px（气场），
  单卡装不下时由 JS（fitOverviewNums，scrollWidth 检测）单独降 24px；窄屏回退 2 列。
- 2026-09-07（二）：按用户意见把「里程碑」并入「今日概览」——四个数值同面板 2×2
  （今日总处理 / 今日权威 / 累计历史总计 / 单日峰值），独立里程碑面板移除。
- 2026-09-07：Token tab 两项增强。①新增「里程碑」面板（今日概览下方）：累计 Token（历史总计，
  含统计起始日 + 活跃天数）与单日峰值（含峰值日期 + 占累计比），从一年热力图序列推导，
  固定含 cache 口径。②Token tab 所有面板可折叠：面板头右侧 chevron 按钮，
  `.panel-body` grid-rows 抽屉动画（复用模型抽屉模式），折叠态持久化 localStorage
  `aub:panel-collapsed`（跨会话保持，方便截图只留想看的卡片）；展开时重绘 canvas。
  probe 新增里程碑数值与折叠持久化断言；hover 断言补 scrollIntoView（页面变长后
  趋势图在首屏外，视口外坐标 mouse.move 静默无效）。

- 2026-08-19（十七）：Grok free 档配额修复——`creditUsagePercent` 是付费 credit 字段，free 用户
  恒省略（之前误显 0%「余量充足」）；真实信号是推理 429 的 `free-usage-exhausted` 报错文本
  （含 `tokens (actual/limit)`，滚动 24h 窗口），从 unified.jsonl 尾部解析，修正后显示 100% 已用尽。
- 2026-08-19（十六）：UI 文案「撞线」全部改「用尽」（告警 chip/渠道副标/注释/README）。

- 2026-08-19（十五）：热力图分档改平方根刻度——log 把高端压平（2.34/5.67/11.74 亿 ln 后归一化
  贴在一起），sqrt 后 0.43/0.67/0.97 分落 3/4/5 档；档位 5→6，色阶拉宽到 12%→100%。

- 2026-08-19（十四）：热力图改版为一年视图（参考 Codex 官网）：52 周 + 2 未来列铺满整宽、
  月份标签移到底部、未来格虚线区分、空格=无数据语义；`/api/token-series` days 上限 90→380。
  格子尺寸用 flex 均分 + aspect-ratio 纯 CSS 自适应（无 JS 计算）。

- 2026-08-19（十三）：修复历史扫描覆盖不全。根因有二：①文件发现按 **mtime** 截断 45 天
  （老会话不再被 touch，5/6 月文件整批漏掉）；②rows 被旧窗口裁剪但文件 offset 已消费，
  历史永久丢失（claude 缓存无版本号，补 v1；codex 升 v3）。修法：codex 按目录/文件名里的
  **内容日期**截断、纳入 `archived_sessions/`、窗口扩到 110 天（覆盖 05-03）；各渠道
  SCAN_DAYS 统一到 ≥95。重建后：codex rows 自 05-03、claude 自 06-04。另查明：codex rows
  停在 08-16 不是 bug——08-17 起只有日更 automation 的会话文件（无 token 用量）。

- 2026-08-19（十二）：Token 页两个交互——趋势柱状图 hover 浮标（日期+总量+渠道分项降序，
  口径跟随切换，DOM 浮标近右缘翻左）与「每日用量」日历热力图（周一起始 12 周、log 分档、
  固定含 cache 口径、hover 出当天总量，复用同一浮标组件）。probe 注意：fixed 定位浮标在
  Playwright fullPage 截图会丢，浮标截图用视口模式。

- 2026-08-19（十一）：README 全面更新至八渠道版（修正开头渠道数、Claude 序列源、订阅价
  等过时描述；新增快捷指令做法、功能全景、配置文件一节）。
- 2026-08-19（十）：配额进度条的时间刻度竖线改为平滑推进——fetch 时锚定 timePct+时刻，
  tickLight 每秒按窗口流速推进（stale 渠道照推，重渲染时重新锚定）；「配额」面板加图例
  「▎竖线 = 窗口时间进度；用量超过竖线 = 消耗快于时间节奏」。
- 2026-08-19（九）：套餐价格换成真实值并支持多币种——Claude Pro $20、Codex Pro $200（非 Plus）、
  Kimi 会员 ¥199/月；config.json 新增 `cnyUsdRate`（默认 7.2），订阅行按原币种显示，
  ROI 与汇总统一折算美元口径。实测：Claude 236.4×、Codex 16.8×、Kimi 1.1×、综合 32.9×。
- 2026-08-19（八）：新增「费用预估与套餐回报」面板（`GET /api/cost-summary`，config.json 的
  modelPrices/subscriptions，刊例价前缀匹配 + _default 兜底标 ~）。
- 2026-08-19（七）：项目别名归并（`server/config.json` 的 `projectAliases`，mtime 热加载）；
  典型场景：项目改名/挪目录后，旧路径的历史用量能并入新路径显示成一行，
  合并行带「已合并 N 个目录」标记 + hover 列源路径。
- 2026-08-19（六）：Token tab 新增「项目」面板（按工作目录聚合，`GET /api/by-project`，
  top6+抽屉，与范围/口径切换联动）。为此 Claude token 序列从 ccusage daily 切换为本地
  增量扫描（ccusage 无 cwd；本地扫描按 message.id 去重、过滤 `<synthetic>`）；
  codex/kimi/grok/deepseek 扫描缓存升级 v2（rows 带 cwd），旧缓存自动全量重建。
- 2026-08-27：Codex 套餐降级 $200 → $100/月（仍叫 Pro，用户确认）。`config.json`
  subscriptions.codex.monthly 改为 100；配置热加载，费用面板即时生效。
- 2026-08-25（二）：Claude 2 月历史回补。用户在桌面 App 用量页看到 2 月 kimi-for-coding
  用量（早期 Claude Code 走 Kimi 网关）；本地 jsonl 已被 Claude Code 历史清理删掉，
  云端接口（claude.ai org usage）只认 cookie 会话（OAuth bearer 403 + Cloudflare），
  但发现 `~/.claude/stats-cache.json`（旧版统计缓存，lastComputedDate 2026-02-25）幸存。
  提取为 `server/data/claude-feb-backfill.json`（dailyModelTokens 口径=input+output，
  cacheRead 按 modelUsage 聚合比例分摊到日，无 cwd），claude.mjs 扫描时合入并标
  `bf:1` 免于 95 天窗口裁剪。5 天：02-11/14/17/23/24（含少量 sonnet-4-5-thinking）。
- 2026-08-25：三处 UI 小改。①右上角时钟改 24 小时制（`本地 15:30 周四`，去掉上午/下午前缀）。
  ②页面改名 Multi-AI Usage Monitor（`<title>` + `<h1>`）。
  ③新增内联 SVG favicon（深底 + 绿/黄/红三用量条，data URI 无额外请求）——此前
  `href="data:,"` 空图标，Chrome 标签页显示默认灰色离线文档图标，辨识度为零。
- 2026-08-20：两处渠道修复。①Antigravity：`RetrieveUserQuotaSummary` 响应按模型分两组
  （Gemini Models / Claude and GPT models），各有独立 weekly+5h 池——平铺后标签加组前缀
  （`Gemini 7天` / `Claude/GPT 5小时`），否则 UI 出现同名窗口行且 `ch.id:label` 倒计时键冲突；
  长标签卡片加 `wide-label` 类（标签列 52→104px，整卡统一保持条形对齐）。
  ②Grok：offline 必带原因 note（未安装/未登录/凭证过期 401/接口不可达），消除
  「暂无配额数据」歧义；gate 内日志兜底失败时改为抛直连原始错误，避免 401 被掩盖。
  实测当日 grok token 已过期（401），offline 属真实状态。
  ③Antigravity health() 原为硬编码 dormant，API 状况模块在 agy 在线时仍显示「未运行」；
  改为跟随最近一次 quota 实况（采到 → OPERATIONAL，未采到 → dormant）。
  ④「已用尽」阈值 95 → 99.5（三处：告警横幅 / 顶部 chip / 卡片副标），95–99.4 新档
  「即将用尽」红色——96% 显示「已用尽」名不副实（Claude 7天 96% 实测触发）。
  随后按用户意见再调：该档位卡片副标优先显示线性外推「即将用尽 · 约 X 后用尽」，
  告警横幅直接「渠道 窗口 约 X 后用尽」（红黄同级文案、红色表紧急），
  烧速不可估才回退剩余百分比；顶部 chip 保留「仅剩 X%」紧凑形态。
  ⑤Kimi offline 也必带原因 note（同 Grok 模式）。用户实测：CLI 闲置一段时间后面板
  offline、说一句话刷新即 online——印证 token 15 分钟过期 + CLI 运行时自动刷新的机制
  （README 原有记载），401 提示语直指行动：「打开一次 Kimi Code 即自动刷新」。
  ⑥顶部 chip 循环裸读 `worstWindow(ch).usedPct`：grok free 档窗口 usedPct=null 时
  worstWindow 返回 null → renderQuota 抛错被 refresh 吞掉 → 整页卡片+API 状态空白
  （2026-08-20 用户 re-login grok 后首次触发）。chip 加 null 兜底「暂缺数据」。
  教训：refresh 的 catch 会吞渲染异常，排查时先抓 console.warn。
- 2026-08-19（五）：新增 Grok / Cursor / Antigravity 三渠道（共 8 个）。Grok 直连 billing 接口 +
  updates.jsonl 轮边界近似 token 序列；Cursor 走 state.vscdb + DashboardService 月账期；
  Antigravity 机会主义采集（agy language server），新增 `dormant` 状态（灰 pill、不进告警、
  不进同步分母）。新增 `tokenData:false` 标记，Cursor/Antigravity 不进 Token tab。
  probe 泄露断言加 `eyJ`（JWT）前缀。
- 2026-08-19（四）：Claude/Codex 配额升级为官方直连接口实时值（参考 QuotaDot 做法）。
  Claude：`api.anthropic.com/api/oauth/usage`（实测 7天 92% vs ccusage 估算 100%——估算偏高）；
  Codex：`chatgpt.com/backend-api/wham/usage`（7天 100%，与 rollout 一致且更实时）。
  两渠道均为「直连 → 旧方案 → offline」降级链 + stale 机制（staleGate 抽到 ttl.mjs 共享）。
  Claude token 刷新写回**未实现**（与 CLI 并发写回有 refresh_token 轮换冲突风险），仅 401 重读重试。
  新增测试钩子 `AUB_TEST_CLAUDE/CODEX_FAIL_AFTER`。
- 2026-08-19（三）：三处修复。①首开竞态：`serve.command` 开浏览器前轮询 `/api/health`（新端点，
  不触发扫描）直到就绪（上限 60s）；前端 mock 回退非终态——每 15s 重试真实源，成功自动切回
  并摘掉 MOCK pill。②Kimi 掉线：quota 查询失败时返回上次成功快照并降级 `stale`
  （副标「数据为 N 分钟前 · 查询失败重试中」，连续失败 30 分钟才 offline）；401 时重读
  credentials 立即重试一次（token 轮换间隙）；credentials 半截 JSON 解析失败同样走 stale。
  ③模型面板「其他 N 项」改抽屉：整行可点（chevron 旋转 + grid-rows 过渡），展开列出全部
  剩余模型明细，比例基准与主列表一致。同日修复抽屉重渲染时 Coding Agent 面板重复追加的 bug
  （renderHbars 重构后漏清 `#agent-bars`）。
- 2026-08-19（二）：OpenRouter 接入真实 key（management key，analytics 一次查 45 天）。
  注意：用户首次把 key 存成了 `server/.env.rtf`（TextEdit 富文本），已转写为纯文本 `.env`
  （chmod 600）——**`.env.rtf` 仍留在 server/ 下，确认 `.env` 生效后可手动删除**。
  adapter 支持 `OPENROUTER_API_KEY`/`OPENROUTER_MANAGEMENT_KEY` 双变量名，key 类型经
  `/auth/key` 的 `is_management_key` 实测判定。
- 2026-08-19：新增第五渠道 OpenRouter（余额制 + 真实花费估值；未配置时降级为 NO KEY）。
  同日修复：余额为 null 的渠道会让 localStorage 历史写入抛错、进而跳过整帧渲染——
  `appendHistory` 已做 null 安全。另：静态服务现在拒绝一切 dotfile 路径（防 `server/.env` 被读）。

## 遗留问题

- Claude/Codex 直连用的是未公开接口（跟随官方客户端行为），可能随时漂移；Claude 的 token
  刷新写回未实现（refresh_token 轮换与 CLI 并发写回有冲突风险），token 彻底过期且 CLI 不刷新时
  会落回 ccusage 估算。
- server 启动后首发 Claude 直连偶发失败（Keychain/网络冷启动），首分钟可能显示 ccusage 估算，
  下个 TTL 周期自愈。2026-09-07 观测：同一冷启动抖动也会让 probe 的 8180 stale 测试
  「claude 首次查询 online」偶发失败（当日 4 跑 2 败），复跑即过，非功能回归。
- Kimi access_token 15 分钟过期：adapter 已有 stale 韧性（失败返上次快照、30 分钟才 offline、
  401 重读 credentials 重试一次）；token 刷新本身仍依赖运行中的 kimi CLI，CLI 长期不跑时
  需要实现 refresh_token 流程（`auth.kimi.com/api/oauth/token`）才能彻底自愈。
- Codex 5h 窗口近期数据里不出現（官方只回 10080min），出现时前端会自动多出「5小时」行。
- 趋势图下方的「等效估值」单价是粗估值（server.mjs `PRICE_PER_M`），占位性质；
  精确费用看「费用预估与套餐回报」面板。
- 首轮全量扫描同步阻塞 server 事件循环（见「缓存与性能」）。
- Antigravity 凭证位置未定位（旧路径已失效），只能靠 agy 运行时的本地 language server 采集；
  agy 不跑则永远 dormant。若哪天定位到凭证，可升级为主动查询。
- Grok token 序列是上下文快照的轮边界近似（见数据源表），不是精确计量；Grok 订阅标签
  （subscriptionTier）直连/日志均未返回，暂不显示。

## 开源版存档（2026-08-19）

通用脱敏版已发布至 https://github.com/isalicema/api-usage-board （由 Claude Code 脱敏）。
独立复查结论：文件内容零密钥/零路径/零项目名残留，截图全 mock，.gitignore 完整；
已知未修项（用户决定不修，理由：目标用户群不在意）——
git author 邮箱为真实 Gmail（在 commit 元数据，需重写历史才能去掉）；
config.json 默认订阅组合与本人真实套餐一致；README 未写明仅支持 macOS、probe 缺依赖说明。

## License

MIT
