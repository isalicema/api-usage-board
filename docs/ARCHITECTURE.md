# 技术实现细节

给想改代码/排查问题的人看的，日常使用不需要读这份文档。

## 数据流

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

## 八渠道来源与字段对照

| 渠道 | 配额 | Token 序列 |
|---|---|---|
| Claude Code | **官方直连（主）**：`GET https://api.anthropic.com/api/oauth/usage`（需 `anthropic-beta: oauth-2025-04-20` 头；未公开接口，可能漂移）。凭证：env `CLAUDE_CODE_OAUTH_TOKEN` → `~/.claude/.credentials.json` → Keychain（`Claude Code-credentials`，hex 先解码）。**回退**：ccusage blocks/daily 估算。都不通 → offline。不做 token 刷新写回（与 CLI 并发写回有 refresh_token 轮换冲突风险），仅 401 重读凭证重试一次 | **本地增量扫描** `~/.claude/projects/*/*.jsonl`：`type=="assistant"` 记录的 `message.usage`，按 `message.id` 去重，过滤 `model=="<synthetic>"`，cwd 取记录的 `cwd` 字段 |
| Codex | **官方直连（主）**：`GET https://chatgpt.com/backend-api/wham/usage`（headers：`originator: Codex Desktop`、`OAI-Product-Sku: CODEX`）。凭证：`~/.codex/auth.json` 的 `tokens.access_token`。窗口 ≤12h→5小时，否则→7天。**回退**：rollout jsonl 尾部 `rate_limits` | rollout jsonl 的 `token_count` 事件 `payload.info.last_token_usage`（turn 增量；权威量=input−cached+output）；model/cwd 取 `turn_context` 事件 |
| Kimi Code | `GET https://api.kimi.com/coding/v1/usages`（复数，单数 404）。Bearer 读 `~/.kimi-code/credentials/kimi-code.json`。token 15 分钟过期：401 重读凭证重试一次，失败走 stale | `session_index.jsonl` → `agents/*/wire.jsonl` 里 `usage.record` + `usageScope=="turn"`；cwd 取 session 的 `workDir` |
| DeepSeek | `GET https://api.deepseek.com/user/balance`，key 手解 `~/.dsh/.credentials.yaml` | `~/.dsh/sessions/**/session.jsonl.zstd`（`zstd -dc`），`chunk.type=="usage"` |
| OpenRouter | `GET /api/v1/credits` + `GET /api/v1/auth/key`（key 类型检测）。key 配置：`server/.env` 或环境变量 | **需 management key**（Settings → Management Keys）。序列用 `POST /api/v1/analytics/query`（一次拿 45 天）。花费为真实 USD。无项目维度 |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（Bearer = `~/.grok/auth.json`）。**注意**：`creditUsagePercent` 是付费 credit 字段，free 用户恒省略——free 额度信号来自推理 429 报错文本（`subscription:free-usage-exhausted`），从 `unified.jsonl` 尾部解析 | `~/.grok/sessions/*/*/updates.jsonl` 的 `params._meta.totalTokens`，语义是上下文体积快照（非单调），近似口径 |
| Cursor | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`。凭证：`state.vscdb`（复制到临时目录只读打开）| 无本地干净日志，`tokenData:false`，不进 Token tab |
| Antigravity | 凭证未定位，机会主义采集：agy 运行时从最新 `cli-*.log` 正则出 language server 端口，POST `RetrieveUserQuotaSummary`。不跑则 `dormant` | 无，`tokenData:false` |

## 项目维度（GET /api/by-project）

按工作目录聚合 token 用量。各渠道 cwd 来源见上表。扫描缓存结构 v2（rows 带 cwd）。

**项目别名归并**：`server/config.json` 的 `projectAliases: { 被归并路径: 目标路径 }`，
server 端合并 tokens/byChannel，被合并的行带 `mergedFrom`，前端显示"已合并 N 个目录"标记。

## 费用预估与套餐回报（GET /api/cost-summary?days=N）

按 模型×token类型 用刊例价折算等效 API 费用，与订阅月付对比出 ROI。

口径：input（未命中缓存部分）× input 价 + cacheRead × cacheRead 价 + cacheWrite × cacheWrite 价
+ output（含 reasoning）× output 价；ROI = 等效费用 ÷（月付折算 × days/30）。OpenRouter 用真实
花费（非估算）；DeepSeek 按量计费；Grok 是近似口径。免费档 ROI 显示 ∞。

`subscriptions` 现在优先通过 Token 用量 tab 的下拉选择器写回（`POST /api/config/subscription`），
也可以直接改 `server/config.json`，两种方式等效。

## 调研备忘：社区共识

为 Coding Agent 补监控面板的同路数项目不少，结论一致：这些"未公开接口"是事实标准做法——
QuotaDot（Claude/Codex 直连的出处）、CodexIsland、aiquokka、llmquota 等都是读本地凭证 + 调
客户端同款端点。Grok 的 billing 接口与 Cursor 的 DashboardService 亦出自该圈子的抓包/逆向共享。
共同风险：接口随时漂移，所以每个渠道都必须有降级链。

## 缓存与性能

- 每渠道 SWR 缓存：quota 60s；token 序列 5–10min；ccusage 10min。过期先返旧数据、后台异步刷新
- codex/kimi/claude/grok 日志做**增量扫描**：按 path+size 记录解析 offset，持久化到
  `server/.cache/*.json`（不进 git），滚动保留 45 天聚合。codex 单文件最大 500M+，分块（16MB）读取
- 已知妥协：增量扫描是同步 fs，首轮会短暂阻塞 server 事件循环（秒级~十几秒，仅首次）

## 主题机制（dark / light）

- 所有随主题变的颜色都是 CSS 变量，`:root` 定义 dark（默认），`[data-theme="light"]` 覆盖浅色一套
- 切换持久化在 localStorage `aub:theme`，首次访问跟随 `prefers-color-scheme`
- 首帧防闪烁：`index.html` 内联脚本在 CSS 加载前写 `data-theme`；切主题需重绘 canvas 图表
  （网格/坐标轴色从 CSS 变量读取）

## 验证（probe）

```bash
node _probe/shots.mjs
```

服务策略：先探测 8177（`serve.command` 常驻端口）——已在跑就复用且跑完不停；8177 空闲才自起
临时 server（PORT=8179），跑完自动停。

probe 断言覆盖：8 渠道配额真实性、dormant/NO KEY 合法态、by-project 非空+别名归并、cost-summary
数值合法、模型/项目抽屉展开收起、时间刻度平滑推进、stale 降级、无密钥泄露（页面/console 不出现
`sk-`/`sk-or-`/`sk-ant-`/`eyJ` 前缀）、canvas 已绘制、控制台无报错。
