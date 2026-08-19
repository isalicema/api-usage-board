// server.mjs — api-usage-board 本地服务（Node 内置模块，零依赖）
// 单端口同时干两件事：托管模块根目录静态文件 + 提供 /api/* 真实数据接口。
// 只绑定 127.0.0.1，不对外。key/token 只进本进程内存，绝不出现在响应/日志里。
//
// 运行：node server/server.mjs（PORT 环境变量可改端口，默认 8177）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from './adapters/claude.mjs';
import { createCodexAdapter } from './adapters/codex.mjs';
import { createKimiAdapter } from './adapters/kimi.mjs';
import { createDeepseekAdapter } from './adapters/deepseek.mjs';
import { createOpenrouterAdapter } from './adapters/openrouter.mjs';
import { createGrokAdapter } from './adapters/grok.mjs';
import { createCursorAdapter } from './adapters/cursor.mjs';
import { createAntigravityAdapter } from './adapters/antigravity.mjs';

const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT) || 8177;

const adapters = [
  createClaudeAdapter(),
  createCodexAdapter(),
  createKimiAdapter(),
  createDeepseekAdapter(),
  createOpenrouterAdapter(),
  createGrokAdapter(),
  createCursorAdapter(),
  createAntigravityAdapter(),
];

// 启动即后台预热（首次 ccusage/全量扫描很慢，预热期间渠道返回 offline/暂缺，不阻塞响应）
for (const a of adapters) a.warm?.();

// ---------- API 组合 ----------

// 单渠道兜底：任何 adapter 失败只标该渠道 offline，不拖垮整包
async function guard(fn, fallback, timeoutMs = 30_000) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  } catch {
    return fallback;
  }
}

async function apiQuota() {
  const channels = await Promise.all(adapters.map(async (a) => {
    const q = await guard(() => a.quota(), null);
    if (!q) return { id: a.id, name: a.name, status: 'offline', kind: 'windows', windows: [] };
    return { id: a.id, name: a.name, ...q };
  }));
  return { fetchedAt: Date.now(), channels };
}

async function apiStatus() {
  const channels = adapters.map((a) => ({ id: a.id, name: a.name, ...a.health() }));
  return { fetchedAt: Date.now(), channels };
}

// 估值单价（$/M tokens，粗略均值；订阅渠道仅作参考，非订阅账单）
const PRICE_PER_M = { claude: 4.5, codex: 2.8, kimi: 0.9, deepseek: 0.4, grok: 1.5 };

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function apiTokenSeries({ days, endOffset, metric }) {
  // tokenData:false 的渠道（Cursor / Antigravity，无本地 token 序列）不进趋势/分布
  const seriesAdapters = adapters.filter((a) => a.tokenData !== false);
  const rowsByChannel = await Promise.all(seriesAdapters.map((a) => guard(() => a.usageRows(), [], 60_000)));

  // 日期轴：本地日期，endOffset=1 时窗口整体向前挪一天（「昨日」视图）
  const dates = [];
  const today = new Date();
  for (let i = days - 1 + endOffset; i >= endOffset; i--) {
    dates.push(localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  }

  const pickVal = (r) => (metric === 'auth' ? r.input + r.output : r.input + r.output + r.cacheRead + r.cacheWrite);

  const channels = seriesAdapters.map((a, i) => {
    const rows = rowsByChannel[i];
    const byDate = new Map();
    for (const r of rows) byDate.set(r.date, (byDate.get(r.date) || 0) + pickVal(r));
    const daily = dates.map((d) => byDate.get(d) || 0);
    return { id: a.id, name: a.name, color: a.color, daily, total: daily.reduce((s, v) => s + v, 0) };
  });

  // 模型分布（当前窗口内）
  const dateSet = new Set(dates);
  const modelAgg = new Map();
  seriesAdapters.forEach((a, i) => {
    for (const r of rowsByChannel[i]) {
      if (!dateSet.has(r.date)) continue;
      const key = `${a.id}|${r.model}`;
      modelAgg.set(key, (modelAgg.get(key) || 0) + pickVal(r));
    }
  });
  const models = [...modelAgg.entries()]
    .map(([k, tokens]) => {
      const [channel, name] = k.split('|');
      return { name, channel, tokens };
    })
    .sort((x, y) => y.tokens - x.tokens);

  // 今日概览（不受窗口参数影响，始终按真实今日/昨日/近 7 日算）
  const allRows = rowsByChannel.flat();
  const sumDay = (dateStr) => allRows.filter((r) => r.date === dateStr)
    .reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
  const realToday = localDateStr(today);
  const yesterday = localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const weekDates = [...Array(7)].map((_, i) => localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  const todayRows = allRows.filter((r) => r.date === realToday);
  const breakdown = todayRows.reduce((s, r) => ({
    input: s.input + r.input, output: s.output + r.output,
    cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  // 等效估值：有真实花费的渠道（OpenRouter rows 带 cost 美元）用真实值，其余按粗估单价折算
  const estimateUSD = Math.round(seriesAdapters.reduce((s, a, i) => {
    const rows = rowsByChannel[i];
    const costSum = rows.reduce((acc, r) => acc + (r.cost || 0), 0);
    if (costSum > 0) {
      const dateSet2 = new Set(dates);
      return s + rows.filter((r) => dateSet2.has(r.date)).reduce((acc, r) => acc + (r.cost || 0), 0);
    }
    const ch = channels[i];
    return s + (ch.total / 1e6) * (PRICE_PER_M[ch.id] || 0);
  }, 0));

  return {
    dates, channels, models,
    today: {
      date: realToday,
      total: breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite,
      auth: breakdown.input + breakdown.output,
      breakdown,
      yesterdayTotal: sumDay(yesterday),
      weekAvg: Math.round(weekDates.reduce((s, d) => s + sumDay(d), 0) / 7),
    },
    estimateUSD,
    metric,
  };
}

// 项目别名归并：server/config.json 的 projectAliases { 被归并路径: 目标路径 }。
// mtime 缓存热加载——改配置不用重启服务。
const CONFIG_FILE = fileURLToPath(new URL('./config.json', import.meta.url));
let cfgCache = { mtime: 0, data: {} };
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs !== cfgCache.mtime) {
      cfgCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch { cfgCache = { mtime: 0, data: {} }; }
  return cfgCache.data;
}

// 套餐选择器写回：只改 subscriptions[channel]，其余字段（modelPrices/projectAliases/...）原样保留。
// 校验从紧：未知 channel / 非法数值一律拒绝，不静默吞错误，避免把 config.json 写坏。
const KNOWN_CHANNEL_IDS = new Set(['claude', 'codex', 'kimi', 'deepseek', 'openrouter', 'grok', 'cursor', 'antigravity']);
function saveSubscription(channelId, sub) {
  if (!KNOWN_CHANNEL_IDS.has(channelId)) throw new Error('unknown channel');
  const plan = String(sub.plan || '').slice(0, 40);
  const monthly = Number(sub.monthly);
  const currency = sub.currency === 'CNY' ? 'CNY' : 'USD';
  if (!plan || !Number.isFinite(monthly) || monthly < 0) throw new Error('invalid subscription');
  let data;
  try { data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { data = {}; }
  data.subscriptions = data.subscriptions || {};
  data.subscriptions[channelId] = { plan, monthly, currency };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n');
  cfgCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, data }; // 立刻让后续读取看到新值，不用等下次 mtime 轮询
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// 按项目文件夹聚合：只统计 rows 带 cwd 的本地日志渠道（OpenRouter 服务端无项目维度，明确排除）
async function apiByProject({ days, endOffset, metric }) {
  const aliases = loadConfig().projectAliases || {};
  const seriesAdapters = adapters.filter((a) => a.tokenData !== false && a.id !== 'openrouter');
  const rowsByChannel = await Promise.all(seriesAdapters.map((a) => guard(() => a.usageRows(), [], 60_000)));
  const dates = new Set();
  const today = new Date();
  for (let i = days - 1 + endOffset; i >= endOffset; i--) {
    dates.add(localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  }
  const pickVal = (r) => (metric === 'auth' ? r.input + r.output : r.input + r.output + r.cacheRead + r.cacheWrite);
  const agg = new Map();
  seriesAdapters.forEach((a, i) => {
    for (const r of rowsByChannel[i]) {
      if (!r.cwd || !dates.has(r.date)) continue;
      const v = pickVal(r);
      if (!v) continue;
      const cwd = aliases[r.cwd] || r.cwd; // 别名归并到目标路径
      const e = agg.get(cwd) || { tokens: 0, byChannel: {}, sources: new Set() };
      e.tokens += v;
      e.byChannel[a.id] = (e.byChannel[a.id] || 0) + v;
      e.sources.add(r.cwd);
      agg.set(cwd, e);
    }
  });
  return [...agg.entries()]
    .map(([cwd, e]) => ({
      project: cwd.split('/').filter(Boolean).pop() || cwd,
      path: cwd,
      tokens: e.tokens,
      byChannel: e.byChannel,
      mergedFrom: e.sources.size > 1 ? [...e.sources] : undefined, // 合并过的行带全部源路径
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

// 费用预估：模型刊例价（server/config.json modelPrices，前缀最长匹配；_default 兜底）。
// 口径：input（未命中缓存部分）× input 价 + cacheRead × cacheRead 价 + cacheWrite × cacheWrite 价
// + output（含 reasoning）× output 价。OpenRouter 用真实 total_usage（USD）。
function priceFor(model, prices) {
  let best = null, bestLen = 0;
  for (const k of Object.keys(prices)) {
    if (k.startsWith('_')) continue;
    if (model.startsWith(k) && k.length > bestLen) { best = prices[k]; bestLen = k.length; }
  }
  return best;
}

async function apiCostSummary({ days }) {
  const cfg = loadConfig();
  const prices = cfg.modelPrices || {};
  const subs = cfg.subscriptions || {};
  const cnyUsdRate = cfg.cnyUsdRate || 7.2;
  const defPrice = prices._default || { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 };
  const seriesAdapters = adapters.filter((a) => a.tokenData !== false);
  const rowsByChannel = await Promise.all(seriesAdapters.map((a) => guard(() => a.usageRows(), [], 60_000)));
  const dates = new Set();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    dates.add(localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  }

  const channels = seriesAdapters.map((a, i) => {
    const rows = rowsByChannel[i].filter((r) => dates.has(r.date));
    if (a.id === 'openrouter') {
      const actualUSD = Math.round(rows.reduce((s, r) => s + (r.cost || 0), 0) * 100) / 100;
      return { id: a.id, name: a.name, actualUSD, subscription: null, roi: null, note: '按量计费 · 真实花费', priced: true };
    }
    let equiv = 0, allPriced = true;
    const byModel = new Map();
    for (const r of rows) {
      const p = priceFor(r.model || '', prices);
      if (!p) allPriced = false;
      const pr = p || defPrice;
      const cost = (r.input * pr.input + r.output * pr.output + r.cacheRead * pr.cacheRead + r.cacheWrite * pr.cacheWrite) / 1e6;
      equiv += cost;
      byModel.set(r.model, (byModel.get(r.model) || 0) + cost);
    }
    const sub = subs[a.id] && !String(a.id).startsWith('_') ? subs[a.id] : null;
    // ROI 统一美元口径：CNY 月付按 cnyUsdRate 折算
    const monthlyUSD = sub ? (sub.currency === 'CNY' ? sub.monthly / cnyUsdRate : sub.monthly) : null;
    const periodCost = sub ? monthlyUSD * (days / 30) : null;
    return {
      id: a.id, name: a.name,
      equivUSD: Math.round(equiv * 100) / 100,
      byModelTop: [...byModel.entries()].map(([model, cost]) => ({ model, cost: Math.round(cost * 100) / 100 }))
        .sort((x, y) => y.cost - x.cost).slice(0, 5),
      subscription: sub ? { ...sub, monthlyUSD: Math.round(monthlyUSD * 100) / 100 } : null,
      roi: sub && monthlyUSD > 0 ? Math.round((equiv / periodCost) * 10) / 10 : null,
      note: a.id === 'grok' ? '近似口径（上下文快照）' : a.id === 'deepseek' ? '按量计费 · 实付以余额扣减（CNY）为准' : undefined,
      priced: allPriced,
    };
  });

  const totalEquiv = channels.reduce((s, c) => s + (c.equivUSD || c.actualUSD || 0), 0);
  const totalMonthly = channels.reduce((s, c) => s + (c.subscription?.monthlyUSD || 0), 0) * (days / 30);
  return {
    days,
    cnyUsdRate,
    channels,
    summary: {
      totalEquivUSD: Math.round(totalEquiv),
      totalMonthlyUSD: Math.round(totalMonthly * 100) / 100,
      roi: totalMonthly > 0 ? Math.round((totalEquiv / totalMonthly) * 10) / 10 : null,
    },
  };
}

// ---------- HTTP 服务 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  try {
    if (url.pathname === '/api/health') return sendJson(res, { ok: true }); // 轻量就绪探针，不触发任何扫描
    if (url.pathname === '/api/quota') return sendJson(res, await apiQuota());
    if (url.pathname === '/api/status') return sendJson(res, await apiStatus());
    if (url.pathname === '/api/token-series') {
      const days = Math.min(380, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30)); // 热力图一年视图需要 ~375
      const endOffset = Math.min(30, Math.max(0, parseInt(url.searchParams.get('endOffset'), 10) || 0));
      const metric = url.searchParams.get('metric') === 'auth' ? 'auth' : 'total';
      return sendJson(res, await apiTokenSeries({ days, endOffset, metric }));
    }
    if (url.pathname === '/api/by-project') {
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
      const endOffset = Math.min(30, Math.max(0, parseInt(url.searchParams.get('endOffset'), 10) || 0));
      const metric = url.searchParams.get('metric') === 'auth' ? 'auth' : 'total';
      return sendJson(res, await apiByProject({ days, endOffset, metric }));
    }
    if (url.pathname === '/api/cost-summary') {
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
      return sendJson(res, await apiCostSummary({ days }));
    }
    if (url.pathname === '/api/config/subscription' && req.method === 'POST') {
      const body = await readJsonBody(req);
      saveSubscription(String(body.channel || ''), body);
      return sendJson(res, { ok: true });
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'internal' })); // 不透出错误细节
  }

  // 静态文件：只允许模块根下的前端资产，禁 server/ _probe/ node_modules/ 及一切 dotfile（如 server/.env）
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const abs = path.normalize(path.join(MODULE_ROOT, p));
  if (!abs.startsWith(MODULE_ROOT) || /\/\.[^/]/.test(abs) || /\/(server|_probe|node_modules)(\/|$)/.test(abs)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`api-usage-board server @ http://127.0.0.1:${PORT}（仅本地，含 /api/*）`);
});
