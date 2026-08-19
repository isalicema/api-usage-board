// adapters/grok.mjs — Grok 渠道
// 配额直连：GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//   （Bearer = ~/.grok/auth.json 的 entry.key JWT；只读不刷新——xAI 轮换 refresh token，
//   多客户端刷新会互顶）。creditUsagePercent 为 0 时字段省略，防御性解析。
//   兜底：直连失败读 ~/.grok/logs/unified.jsonl 最新「billing: fetched credits config」。
// Token 序列：~/.grok/sessions/*/*/updates.jsonl 的 params._meta.totalTokens。
//   语义实测（2026-08-19）：是上下文体积快照——每轮内随流式增长、跨轮回落（非单调），
//   既不是累计也不是增量。近似口径：回落点（或 EOF）为轮边界，取每轮末值求和
//   （≈ 每轮重发的上下文 token 总量，偏高但量级正确）。增量扫描，缓存 server/.cache/grok-scan.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { swr, staleGate } from '../ttl.mjs';
import { readNewLines, localDate } from '../scan-util.mjs';

const HOME = os.homedir();
const GROK_DIR = path.join(HOME, '.grok');
const CACHE_FILE = fileURLToPath(new URL('../.cache/grok-scan.json', import.meta.url));
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SCAN_DAYS = 95; // 覆盖热力图 84 天 + 余量

function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(GROK_DIR, 'auth.json'), 'utf8'));
    for (const k of Object.keys(j)) {
      if (j[k]?.key) return j[k].key;
    }
  } catch {}
  return null;
}

function mapConfig(config) {
  const p = config.currentPeriod || {};
  const weekly = p.type === 'USAGE_PERIOD_TYPE_WEEKLY';
  const windowSec = weekly ? 7 * 86400 : 30 * 86400;
  const end = Date.parse(p.end);
  const start = Date.parse(p.start);
  const now = Date.now();
  const resetInSec = isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : null;
  return {
    label: weekly ? '7天' : '月账期',
    windowSec,
    usedPct: Math.round((Number(config.creditUsagePercent) || 0) * 10) / 10,
    timePct: isFinite(start) && isFinite(end) ? Math.min(100, Math.round(((now - start) / (end - start)) * 100)) : null,
    resetInSec,
  };
}

// free 用户：billing 接口不含 creditUsagePercent（付费 credit 用量字段，免费档恒省略）。
// 唯一真实信号是推理 429 的报错文本（unified.jsonl 的 rate_limited 事件），内含
// 「tokens (actual/limit): A/L」+ rolling 24-hour window 语义。24h 内有用尽事件 → 按 A/L 显示。
function readFreeExhaustion() {
  try {
    const logFile = path.join(GROK_DIR, 'logs', 'unified.jsonl');
    const st = fs.statSync(logFile);
    const fd = fs.openSync(logFile, 'r');
    const start = Math.max(0, st.size - 1024 * 1024);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('free-usage-exhausted')) continue;
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; }
      const msg = j.ctx?.message || j.message || '';
      const m = msg.match(/tokens \(actual\/limit\): (\d+)\/(\d+)/);
      const ts = Date.parse(j.ts || j.timestamp || '');
      if (!m || !isFinite(ts)) continue;
      const ageMs = Date.now() - ts;
      if (ageMs > 24 * 3600_000) return null; // 滚动窗口已过，额度视为已恢复
      return {
        usedPct: Math.min(100, Math.round((Number(m[1]) / Number(m[2])) * 1000) / 10),
        limit: Number(m[2]),
        // 滚动窗口没有精确 reset 点：近似 = 事件后 24h
        resetInSec: Math.max(0, Math.round(86400 - ageMs / 1000)),
      };
    }
  } catch {}
  return null;
}

async function fetchDirect() {
  const token = readToken();
  if (!token) throw new Error('no grok credentials');
  const res = await fetch(BILLING_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`grok billing HTTP ${res.status}`);
  const j = await res.json();
  if (!j.config) throw new Error('grok billing: no config');
  if (j.config.creditUsagePercent != null) {
    return { windows: [mapConfig(j.config)], source: 'direct' };
  }
  // free 档：billing 无配额字段 → 用 429 日志信号近似（见 readFreeExhaustion 注释）
  const free = readFreeExhaustion();
  const w = mapConfig(j.config);
  if (free) {
    w.usedPct = free.usedPct;
    w.resetInSec = free.resetInSec;
    w.timePct = w.windowSec ? Math.min(100, Math.round((1 - free.resetInSec / 86400) * 100)) : null;
    return { windows: [w], source: 'direct+429log', note: `free 滚动 24h 额度（${fmtK(free.limit)} tok，来自 429 报错，接口未暴露正式配额）` };
  }
  // free 且近期无用尽事件：接口确实没数据，如实标暂缺
  w.usedPct = null;
  return { windows: [w], source: 'direct', note: 'free 额度接口未暴露，以客户端提示为准' };
}

function fmtK(n) { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }

function fetchFromLog() {
  const logFile = path.join(GROK_DIR, 'logs', 'unified.jsonl');
  const st = fs.statSync(logFile);
  const fd = fs.openSync(logFile, 'r');
  const start = Math.max(0, st.size - 512 * 1024);
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('billing: fetched credits config')) continue;
    try {
      const j = JSON.parse(lines[i]);
      const config = j.ctx?.config;
      if (config?.currentPeriod) {
        return { windows: [mapConfig(config)], source: 'log', note: '来自本地日志缓存' };
      }
    } catch { continue; }
  }
  throw new Error('no billing config in grok log');
}

// Token 序列扫描（轮边界近似，见文件头注释）
function scan() {
  const cache = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (c.v !== 2) throw new Error('v1→v2: rows 增加 cwd 维度，全量重扫');
      return c;
    } catch { return { v: 2, files: {}, rows: {} }; }
  })();
  const sessionsDir = path.join(GROK_DIR, 'sessions');
  const files = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  let projects = [];
  try { projects = fs.readdirSync(sessionsDir); } catch { projects = []; }
  for (const proj of projects) {
    if (proj.endsWith('.sqlite')) continue; // session_search.sqlite 不是目录
    const cwd = decodeURIComponent(proj); // 目录名即 URL 编码的项目路径
    let subs = [];
    try { subs = fs.readdirSync(path.join(sessionsDir, proj)); } catch { continue; }
    for (const s of subs) {
      const p = path.join(sessionsDir, proj, s, 'updates.jsonl');
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) files.push({ path: p, size: st.size, cwd });
      } catch {}
    }
  }

  const keepAfter = localDate(Date.now() - SCAN_DAYS * 86400000);
  for (const f of files) {
    const rec = cache.files[f.path];
    const fresh = !(rec && rec.size <= f.size); // 文件变小视为重写：全量重扫且重置发射状态
    const offset = fresh ? 0 : rec.offset;
    if (offset >= f.size) { if (rec) rec.size = f.size; continue; }
    const r = fresh ? (cache.files[f.path] = {}) : rec;
    // 状态跨增量边界保持：turnSum（已完结轮累计）/curMax（当前轮峰值）/emitted（已入账总量）
    let turnSum = r.turnSum || 0, curMax = r.curMax || 0, lastTs = r.lastTs || 0;
    r.offset = readNewLines(f.path, offset, (line) => {
      if (!line.includes('totalTokens')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const tok = j.params?._meta?.totalTokens ?? j.params?.update?._meta?.totalTokens;
      const ts = j.timestamp;
      if (tok == null || !ts) return;
      const ms = ts > 1e12 ? ts : ts * 1000;
      if (tok < curMax) { turnSum += curMax; curMax = tok; } // 轮边界：回落
      else curMax = tok;
      lastTs = ms;
    });
    // EOF 入账在途轮：只记增量（turnSum+curMax − 已发射），避免增量重扫重复计
    const total = turnSum + curMax;
    const pending = total - (r.emitted || 0);
    if (pending > 0 && lastTs) {
      const date = localDate(lastTs);
      if (date >= keepAfter) {
        const key = `${date}|${f.cwd || ''}`;
        const row = cache.rows[key] || (cache.rows[key] = { date, model: 'grok', cwd: f.cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        row.input += pending;
      }
      r.emitted = total;
    }
    r.turnSum = turnSum; r.curMax = curMax; r.lastTs = lastTs; r.size = f.size;
  }
  for (const k of Object.keys(cache.rows)) if (cache.rows[k].date < keepAfter) delete cache.rows[k];
  for (const p of Object.keys(cache.files)) if (!files.some((f) => f.path === p)) delete cache.files[p];
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {}
  return Object.values(cache.rows);
}

export function createGrokAdapter() {
  const gate = staleGate(60_000, 30 * 60_000, async () => {
    try { return await fetchDirect(); } catch { return fetchFromLog(); }
  });
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'grok', name: 'Grok', color: '#f472b6',
    warm() { gate({}).catch(() => {}); rowsCache.warm(); },
    async quota() {
      const t0 = Date.now();
      const r = await gate({});
      lastLatency = Date.now() - t0; lastOk = Date.now();
      const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
      if (r.stale) {
        const mins = Math.max(1, Math.round(r.ageMs / 60000));
        return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
      }
      return { ...base, status: 'online' };
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
