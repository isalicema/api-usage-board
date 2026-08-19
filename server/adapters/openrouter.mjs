// adapters/openrouter.mjs — OpenRouter 渠道
// key 配置：server/.env（优先）或环境变量；支持两个变量名：
//   OPENROUTER_API_KEY（推理 key）/ OPENROUTER_MANAGEMENT_KEY（management key）。
// 安全红线：key 只进内存，绝不进日志/响应。
//
// 实测结论（2026-08-19）：
// - analytics 系列接口（/analytics/*）要 management key（Settings → Management Keys 创建，
//   只读、不能发推理）；普通推理 key 调会 403。/activity、/credits、/auth/key 两种 key 都通。
// - POST /analytics/query：body {metrics, dimensions(≤2), granularity, time_range:{start,end}（要完整
//   ISO datetime，纯日期 400）, limit}；响应 {data:{data:[rows], metadata}}，行字段 date__day 等；
//   count 类指标（tokens_*/request_count）返回字符串，必须防御性 Number() 解析。
// - management key 调 /auth/key：is_management_key=true 且 usage=0（key 维度无意义，不展示该行）。
// - 配额快照：/credits（余额 = total_credits − total_usage）+ /auth/key（key 类型检测 / 普通 key 的限额行）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swr } from '../ttl.mjs';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
const CACHE_FILE = fileURLToPath(new URL('../.cache/openrouter-analytics.json', import.meta.url));
const BASE = 'https://openrouter.ai/api/v1';
const SERIES_DAYS = 45;

function readApiKey() {
  const fromEnvFile = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*(OPENROUTER_(?:API|MANAGEMENT)_KEY)\s*=\s*(.+?)\s*$/);
      if (m) fromEnvFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return {
    key: fromEnvFile.OPENROUTER_API_KEY || fromEnvFile.OPENROUTER_MANAGEMENT_KEY
      || process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_MANAGEMENT_KEY || null,
    hintedManagement: !!(fromEnvFile.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_MANAGEMENT_KEY),
  };
}

async function orGet(pathname, key) {
  const res = await fetch(BASE + pathname, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`openrouter GET ${pathname} HTTP ${res.status}`);
  return res.json();
}

async function orAnalyticsQuery(key, body) {
  const res = await fetch(BASE + '/analytics/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`openrouter analytics/query HTTP ${res.status}`);
  return res.json();
}

async function fetchQuotaRaw() {
  const { key } = readApiKey();
  if (!key) return { configured: false };
  const t0 = Date.now();
  const keyRes = await orGet('/auth/key', key);
  const latencyMs = Date.now() - t0;
  const creditsRes = await orGet('/credits', key).catch(() => null);

  const kd = keyRes.data || {};
  const isMgmt = kd.is_management_key === true;
  const cd = creditsRes?.data || null;
  const amount = cd ? +(cd.total_credits - cd.total_usage).toFixed(2) : null;
  // management key 的 usage 恒为 0（不能发推理），key 维度行只对普通推理 key 有意义
  const extra = !isMgmt && kd.limit != null
    ? `key 用量 $${Number(kd.usage).toFixed(2)} / $${Number(kd.limit).toFixed(2)}`
    : null;
  return {
    configured: true, isManagementKey: isMgmt,
    amount, currency: 'USD', extra, latencyMs,
  };
}

function loadAnalyticsCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { ts: 0, rows: [] }; }
}
function saveAnalyticsCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

const num = (v) => Number(v) || 0; // count 类指标返回字符串，防御性解析

async function fetchSeriesRaw(isManagementKey) {
  const { key } = readApiKey();
  if (!key || !isManagementKey) return null; // 无 key 或非 management：无 analytics，走空序列
  const end = new Date().toISOString();
  const start = new Date(Date.now() - SERIES_DAYS * 86400000).toISOString();
  const j = await orAnalyticsQuery(key, {
    metrics: ['total_usage', 'tokens_prompt', 'tokens_completion', 'reasoning_tokens', 'cached_tokens'],
    dimensions: ['model'],
    granularity: 'day',
    time_range: { start, end },
    limit: 1000,
  });
  const rows = (j.data?.data || []).map((r) => {
    const cached = num(r.cached_tokens);
    const prompt = num(r.tokens_prompt);
    return {
      date: String(r.date__day || '').slice(0, 10), // UTC 日
      model: r.model || 'unknown',
      input: Math.max(0, prompt - cached), // cached ⊂ prompt，权威量不含 cache
      output: num(r.tokens_completion) + num(r.reasoning_tokens),
      cacheRead: cached, cacheWrite: 0,
      cost: num(r.total_usage), // 真实花费（美元）
    };
  }).filter((r) => r.date);
  saveAnalyticsCache({ ts: Date.now(), rows });
  return rows;
}

export function createOpenrouterAdapter() {
  const quotaCache = swr(60_000, fetchQuotaRaw);
  const rowsCache = swr(10 * 60_000, async () => {
    const q = await quotaCache.get(); // 复用 quota 的 key 类型结论
    const rows = await fetchSeriesRaw(q.configured && q.isManagementKey).catch(() => null);
    if (rows) return rows;
    return loadAnalyticsCache().rows; // 失败回退磁盘快照
  });
  let lastLatency = 0, lastOk = 0;

  return {
    id: 'openrouter', name: 'OpenRouter', color: '#f59e0b',
    warm() { quotaCache.warm(); rowsCache.warm(); },
    async quota() {
      const q = await quotaCache.get();
      if (!q.configured) {
        return { status: 'unconfigured', kind: 'balance', balance: null, note: '未配置 key' };
      }
      lastLatency = q.latencyMs; lastOk = Date.now();
      return {
        status: 'online', kind: 'balance',
        balance: q.amount != null ? { amount: q.amount, currency: q.currency } : null,
        extra: q.extra || undefined,
        note: q.isManagementKey ? undefined : 'analytics 需 management key（Settings → Management Keys）',
      };
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      if (!readApiKey().key) return { state: 'unconfigured', latencyMs: 0 };
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
