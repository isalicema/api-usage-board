// mock-data.js — MockSource：实现统一 Source 接口的 mock 数据源。
//
// 接口约定（与未来的真实 adapter 保持一致，全部为 async）：
//   fetchQuota()                       → 配额/余额快照
//   fetchTokenSeries({days, endOffset, metric}) → 每日×渠道堆叠序列 + 模型分布 + 今日概览
//   fetchApiStatus()                   → 各渠道健康状态与延迟
//
// 截图稳定性约定：同一页面生命周期内，第 0 次 fetch 完全由固定种子决定（无抖动），
// 之后的每次 fetch（轮询 tick）叠加一个随 tick 递增的小幅抖动，模拟「活着」的数据。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260818;

export const CHANNELS = [
  { id: 'claude',   name: 'Claude Code', color: '#5aa9ff' },
  { id: 'codex',    name: 'Codex',       color: '#b78cff' },
  { id: 'kimi',     name: 'Kimi Code',   color: '#22d3ee' },
  { id: 'deepseek', name: 'DeepSeek',    color: '#34d399' },
  // 以下按真实 server 渠道顺序追加（Cursor 无 token 序列，不进 mock）；rng 按顺序消耗，
  // 追加在后不改变前 4 个渠道的既有示意数据
  { id: 'openrouter',  name: 'OpenRouter',  color: '#f59e0b' },
  { id: 'grok',        name: 'Grok',        color: '#f472b6' },
  { id: 'antigravity', name: 'Antigravity', color: '#fb7185' },
  { id: 'gemini',      name: 'Gemini API',  color: '#ffc800' },
];

const HOUR = 3600, DAY = 86400;

// 基准配额（截图稳定性的来源）。usedPct/timePct 一经确定，告警与用尽预测全部由此推导。
const QUOTA_BASE = {
  kimi: {
    status: 'online', kind: 'windows',
    windows: [
      { label: '5小时', windowSec: 5 * HOUR,  usedPct: 18, timePct: 35, resetInSec: 3 * HOUR + 15 * 60 },
      { label: '7天',   windowSec: 7 * DAY,   usedPct: 92, timePct: 65, resetInSec: 2 * DAY + 10 * HOUR },
    ],
  },
  claude: {
    status: 'online', kind: 'windows',
    windows: [
      { label: '5小时', windowSec: 5 * HOUR,  usedPct: 45, timePct: 52, resetInSec: 2 * HOUR + 24 * 60 },
      { label: '7天',   windowSec: 7 * DAY,   usedPct: 97, timePct: 78, resetInSec: 1 * DAY + 13 * HOUR },
    ],
  },
  codex: {
    status: 'online', kind: 'windows',
    windows: [
      { label: '5小时', windowSec: 5 * HOUR,  usedPct: 62, timePct: 55, resetInSec: 2 * HOUR + 6 * 60 },
      { label: '7天',   windowSec: 7 * DAY,   usedPct: 99, timePct: 85, resetInSec: 21 * HOUR },
      // 月账期窗口暂缺数据，用来走「暂缺数据」分支
      { label: '月账期', windowSec: 30 * DAY, usedPct: null, timePct: 61, resetInSec: 11 * DAY + 9 * HOUR },
    ],
  },
  deepseek: {
    status: 'online', kind: 'balance',
    balance: { amount: 1037.84, currency: 'CNY' },
  },
  openrouter: {
    status: 'online', kind: 'balance',
    balance: { amount: 42.17, currency: 'USD' },
  },
  grok: {
    status: 'online', kind: 'windows',
    windows: [
      { label: '月账期', windowSec: 30 * DAY, usedPct: 34, timePct: 48, resetInSec: 15 * DAY + 6 * HOUR },
    ],
  },
  antigravity: {
    status: 'online', kind: 'windows',
    windows: [
      { label: 'Gemini 5小时',     windowSec: 5 * HOUR, usedPct: 12, timePct: 40, resetInSec: 3 * HOUR },
      { label: 'Gemini 7天',       windowSec: 7 * DAY,  usedPct: 41, timePct: 57, resetInSec: 3 * DAY },
      { label: 'Claude/GPT 5小时', windowSec: 5 * HOUR, usedPct: 58, timePct: 62, resetInSec: 1 * HOUR + 54 * 60 },
      { label: 'Claude/GPT 7天',   windowSec: 7 * DAY,  usedPct: 70, timePct: 57, resetInSec: 3 * DAY },
    ],
  },
  gemini: {
    status: 'online', kind: 'usage', note: '无官方用量接口 · 读本地会话记录',
    today: { tokens: 18.6e6, requests: 214 },
  },
};

const LATENCY_BASE = { kimi: 182, claude: 246, codex: 211, deepseek: 328, openrouter: 297, grok: 264, antigravity: 38, gemini: 0 };

// 每渠道的模型构成（份额），尾部小模型会被聚合为「其他 N 项」
const MODEL_SPLIT = {
  claude:   [['claude-sonnet-5', 0.68], ['claude-opus-4.5', 0.22], ['claude-haiku-4.5', 0.10]],
  codex:    [['gpt-5.6', 0.74], ['gpt-5.6-mini', 0.19], ['gpt-5.6-nano', 0.07]],
  kimi:     [['kimi-code/k3', 0.82], ['kimi-k2-thinking', 0.18]],
  deepseek: [['deepseek-v4', 0.91], ['deepseek-v4-flash', 0.09]],
  openrouter:  [['qwen/qwen3-coder', 0.58], ['z-ai/glm-5', 0.42]],
  grok:        [['grok-code-fast-2', 0.77], ['grok-5', 0.23]],
  antigravity: [['gemini-3.8-flash', 0.55], ['claude-sonnet-5', 0.45]],
  gemini:      [['gemini-3.8-flash', 0.64], ['gemini-3.1-pro-preview', 0.36]],
};

// 估值单价（$/M tokens，粗略均值），仅用于「等效估值」小结
const PRICE_PER_M = { claude: 4.5, codex: 2.8, kimi: 0.9, deepseek: 0.4, openrouter: 1.0, grok: 1.5, antigravity: 0.5, gemini: 1.2 };

// 项目维度 mock（示意用，纯虚构名字，不对应任何真实目录）
const MOCK_PROJECTS = [
  { project: 'project-alpha', path: '~/Code/project-alpha', tokens: 4.1e9, byChannel: { claude: 2.6e9, codex: 1.5e9 } },
  { project: 'internal-tool', path: '~/Code/internal-tool', tokens: 2.3e9, byChannel: { codex: 1.8e9, kimi: 5e8 } },
  { project: 'demo-app', path: '~/Code/demo-app', tokens: 1.4e9, byChannel: { claude: 1.1e9, deepseek: 3e8 },
    mergedFrom: ['~/Code/demo-app-old', '~/Code/demo-app'] }, // 示意「已合并 N 个目录」标记
  { project: 'notes-sync', path: '~/Code/notes-sync', tokens: 6.2e8, byChannel: { kimi: 4.1e8, antigravity: 2.1e8 } },
  { project: 'sandbox', path: '~/Code/sandbox', tokens: 2.1e8, byChannel: { claude: 2.1e8 } },
  { project: 'data-pipeline', path: '~/Code/data-pipeline', tokens: 1.3e8, byChannel: { gemini: 1.3e8 } },
];

// 套餐 mock（仅作展示；真实数据由 server/config.json 的 subscriptions 决定）
const MOCK_SUBSCRIPTIONS = {
  claude: { plan: 'Pro', monthly: 20, currency: 'USD' },
  codex: { plan: 'Pro', monthly: 200, currency: 'USD' },
  kimi: { plan: '会员', monthly: 199, currency: 'CNY' },
  grok: { plan: 'SuperGrok', monthly: 30, currency: 'USD' },
  antigravity: { plan: 'AI Pro', monthly: 19.99, currency: 'USD' },
};

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

export function createMockSource() {
  let tick = 0; // 第 0 次 fetch 无抖动

  // —— 每日 token 序列（确定性，与 tick 无关；历史即事实）——
  // 每个渠道每天生成权威量（auth = input+output）与 cache 量（cache read/write）。
  function genDailySeries(days, endOffset) {
    const rng = mulberry32(SEED);
    const dates = [];
    const today = new Date();
    for (let i = days - 1 + endOffset; i >= endOffset; i--) {
      dates.push(dateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
    }
    const auth = {}, cache = {};
    for (const ch of CHANNELS) {
      auth[ch.id] = []; cache[ch.id] = [];
      const base0 = { claude: 3.2e8, codex: 2.4e8, kimi: 1.6e8, deepseek: 0.9e8, openrouter: 0.4e8, grok: 0.3e8, antigravity: 0.7e8, gemini: 0.5e8 }[ch.id];
      for (let d = 0; d < days + endOffset; d++) {
        const seasonal = 0.75 + 0.5 * Math.sin(d / 3.1 + ch.id.length);
        const growth = 1 + d * 0.012;
        const noise = 0.7 + rng() * 0.6;
        const total = base0 * seasonal * growth * noise;
        const authShare = 0.32 + rng() * 0.14; // cache read/write 占大头
        const a = Math.round(total * authShare);
        auth[ch.id].push(a);
        cache[ch.id].push(Math.round(total - a));
      }
      // 只保留请求的窗口（去掉 endOffset 之外的尾部）
      auth[ch.id] = auth[ch.id].slice(0, days);
      cache[ch.id] = cache[ch.id].slice(0, days);
    }
    return { dates, auth, cache };
  }

  return {
    name: 'mock',

    async fetchQuota() {
      const t = tick++;
      const rng = mulberry32(SEED + t * 7919);
      const jitter = t === 0 ? 0 : 1; // 首轮无抖动
      const channels = CHANNELS.map((ch) => {
        const b = QUOTA_BASE[ch.id];
        if (b.kind === 'usage') {
          const add = jitter ? Math.round(rng() * 2e5) : 0;
          return { id: ch.id, name: ch.name, status: b.status, kind: 'usage', note: b.note,
            today: { tokens: b.today.tokens + add, requests: b.today.requests + (jitter ? 1 : 0) } };
        }
        if (b.kind === 'balance') {
          const spend = jitter ? +(rng() * 0.4).toFixed(2) : 0;
          return {
            id: ch.id, name: ch.name, status: b.status, kind: 'balance',
            balance: { amount: +(b.balance.amount - spend).toFixed(2), currency: b.balance.currency },
          };
        }
        return {
          id: ch.id, name: ch.name, status: b.status, kind: 'windows',
          windows: b.windows.map((w) => {
            if (w.usedPct == null) return { ...w };
            const j = jitter ? Math.round(rng() * 10) / 10 : 0;
            return { ...w, usedPct: Math.min(100, +(w.usedPct + j).toFixed(1)) };
          }),
        };
      });
      return { fetchedAt: Date.now(), channels };
    },

    async fetchTokenSeries({ days = 30, endOffset = 0, metric = 'total' } = {}) {
      const { dates, auth, cache } = genDailySeries(days, endOffset);
      const pick = (id) => dates.map((_, i) => (metric === 'auth' ? auth[id][i] : auth[id][i] + cache[id][i]));

      // 渠道汇总
      const channels = CHANNELS.map((ch) => {
        const arr = pick(ch.id);
        return { id: ch.id, name: ch.name, color: ch.color, daily: arr, total: arr.reduce((s, v) => s + v, 0) };
      });

      // 模型分布（按渠道 total 拆分）
      const models = [];
      for (const ch of channels) {
        for (const [m, share] of MODEL_SPLIT[ch.id]) {
          models.push({ name: m, channel: ch.id, tokens: Math.round(ch.total * share) });
        }
      }
      models.sort((a, b) => b.tokens - a.tokens);

      // 今日概览（固定种子，含 input/output/cache read/write 拆分）
      const todayRng = mulberry32(SEED + 1);
      const tIdx = dates.length - 1;
      const todayCh = CHANNELS.map((ch) => {
        const a = auth[ch.id][tIdx], c = cache[ch.id][tIdx];
        const input = Math.round(a * (0.55 + todayRng() * 0.2));
        const output = a - input;
        const cacheRead = Math.round(c * 0.9);
        const cacheWrite = c - cacheRead;
        return { id: ch.id, input, output, cacheRead, cacheWrite, total: a + c, auth: a };
      });
      const sum = (k) => todayCh.reduce((s, x) => s + x[k], 0);

      // 昨日总量与近 7 日均值（独立生成，不依赖当前 range）
      const ref = genDailySeries(8, 0);
      const dayTotal = (idx) => CHANNELS.reduce((s, ch) => s + ref.auth[ch.id][idx] + ref.cache[ch.id][idx], 0);
      const yesterdayTotal = dayTotal(6);
      const weekAvg = Math.round([0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + dayTotal(i), 0) / 7);

      // 等效估值（部分渠道按付费价折算，订阅渠道仅作参考 → 标注「非订阅账单」）
      const estimateUSD = Math.round(
        channels.reduce((s, ch) => s + (ch.total / 1e6) * PRICE_PER_M[ch.id], 0)
      );

      return {
        dates, channels, models,
        today: {
          date: dates[tIdx],
          total: sum('total'), auth: sum('auth'),
          breakdown: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') },
          yesterdayTotal, weekAvg,
        },
        estimateUSD,
        metric,
      };
    },

    async fetchByProject({ days = 30 } = {}) {
      // 纯示意：固定虚构项目名 + 抖动 token 数，不依赖真实文件系统
      const rng = mulberry32(SEED + 31);
      return MOCK_PROJECTS
        .map((p) => ({ ...p, tokens: Math.round(p.tokens * (0.9 + rng() * 0.2)) }))
        .sort((a, b) => b.tokens - a.tokens);
    },

    async fetchCostSummary({ days = 30 } = {}) {
      const cnyUsdRate = 7.2;
      const channels = CHANNELS.map((ch) => {
        const base = { claude: 4700, codex: 3300, kimi: 40, deepseek: 60, openrouter: 38, grok: 120, antigravity: 210, gemini: 85 }[ch.id];
        if (ch.id === 'openrouter') {
          return { id: ch.id, name: ch.name, actualUSD: base, subscription: null, roi: null, note: '按量计费 · 真实花费', priced: true };
        }
        if (ch.id === 'deepseek' || ch.id === 'gemini') {
          const note = ch.id === 'gemini' ? '按量计费 · 刊例价估算' : '按量计费 · 示意';
          return { id: ch.id, name: ch.name, equivUSD: base, subscription: null, roi: null, note, priced: true };
        }
        const equivUSD = base;
        const sub = MOCK_SUBSCRIPTIONS[ch.id];
        const monthlyUSD = sub.currency === 'CNY' ? sub.monthly / cnyUsdRate : sub.monthly;
        const periodCost = monthlyUSD * (days / 30);
        return {
          id: ch.id, name: ch.name, equivUSD,
          byModelTop: (MODEL_SPLIT[ch.id] || []).map(([model, share]) => ({ model, cost: Math.round(equivUSD * share) })),
          subscription: { ...sub, monthlyUSD: Math.round(monthlyUSD * 100) / 100 },
          roi: Math.round((equivUSD / periodCost) * 10) / 10,
          priced: true,
        };
      });
      const totalEquiv = channels.reduce((s, c) => s + (c.equivUSD || c.actualUSD || 0), 0);
      const totalMonthly = channels.reduce((s, c) => s + (c.subscription?.monthlyUSD || 0), 0) * (days / 30);
      return {
        days, cnyUsdRate, channels,
        summary: {
          totalEquivUSD: Math.round(totalEquiv),
          totalMonthlyUSD: Math.round(totalMonthly * 100) / 100,
          roi: totalMonthly > 0 ? Math.round((totalEquiv / totalMonthly) * 10) / 10 : null,
        },
      };
    },

    async fetchApiStatus() {
      const t = tick++;
      const rng = mulberry32(SEED + 13 + t * 104729);
      const jitter = t === 0 ? 0 : 1;
      return {
        fetchedAt: Date.now(),
        channels: CHANNELS.map((ch) => ({
          id: ch.id, name: ch.name,
          state: 'operational',
          latencyMs: LATENCY_BASE[ch.id] && jitter ? LATENCY_BASE[ch.id] + Math.round(rng() * 30 - 15) : LATENCY_BASE[ch.id], // 0 = 无接口可测（Gemini 读本地文件），不加抖动
        })),
      };
    },
  };
}
