// adapters/kimi.mjs — Kimi Code 渠道
// 配额：GET https://api.kimi.com/coding/v1/usages（Bearer = ~/.kimi-code/credentials/kimi-code.json
//       的 access_token；文件每次现读，kimi CLI 运行时会自己刷新 token）。
//       安全红线：token 只进内存，绝不进日志/响应。
// Token：session_index.jsonl → 各 session 的 agents/*/wire.jsonl 里
//        type=="usage.record" && usageScope=="turn" 的记录（增量扫描，容忍实时写入）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { swr } from '../ttl.mjs';
import { readNewLines, localDate } from '../scan-util.mjs';

const HOME = os.homedir();
const KIMI_DIR = path.join(HOME, '.kimi-code');
const SESSION_INDEX = path.join(KIMI_DIR, 'session_index.jsonl');
const CACHE_FILE = fileURLToPath(new URL('../.cache/kimi-scan.json', import.meta.url));
const USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const SCAN_DAYS = 95; // 覆盖热力图 84 天 + 余量

function readAccessToken() {
  for (const p of [path.join(KIMI_DIR, 'credentials', 'kimi-code.json'), path.join(KIMI_DIR, 'oauth', 'kimi-code')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && typeof j.access_token === 'string' && j.access_token) return j.access_token;
    } catch {}
  }
  return null;
}

// 测试钩子：AUB_TEST_KIMI_FAIL_AFTER=N 时第 N+1 次起查询必失败（供 probe 构造 stale 场景）
const TEST_FAIL_AFTER = parseInt(process.env.AUB_TEST_KIMI_FAIL_AFTER || '', 10);
let testCalls = 0;
const TEST_MODE = !isNaN(TEST_FAIL_AFTER);

async function fetchQuotaOnce(token) {
  const t0 = Date.now();
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Date.now() - t0;
  return { res, latencyMs };
}

async function fetchQuotaRaw() {
  if (TEST_MODE && ++testCalls > TEST_FAIL_AFTER) throw new Error('simulated failure (AUB_TEST_KIMI_FAIL_AFTER)');
  let token = readAccessToken();
  if (!token) throw new Error('no kimi credentials');
  // 401 时立即重读 credentials 再试一次：CLI 可能刚刷完 token（轮换间隙读到旧的）
  let { res, latencyMs } = await fetchQuotaOnce(token);
  if (res.status === 401) {
    const token2 = readAccessToken();
    if (token2 && token2 !== token) {
      ({ res, latencyMs } = await fetchQuotaOnce(token2));
    }
  }
  if (!res.ok) throw new Error(`kimi usages HTTP ${res.status}`);
  const j = await res.json();
  const now = Date.now();
  const mk = (label, windowSec, limit, used, resetTime) => {
    const l = Number(limit), u = Number(used);
    const resetInSec = Math.max(0, Math.round((Date.parse(resetTime) - now) / 1000));
    return {
      label, windowSec,
      usedPct: l > 0 ? Math.round((u / l) * 1000) / 10 : null,
      timePct: windowSec ? Math.min(100, Math.round((1 - resetInSec / windowSec) * 100)) : null,
      resetInSec,
    };
  };
  const windows = [];
  // 5 小时窗口：limits[] 里 duration=300 MINUTE
  for (const it of j.limits || []) {
    if (it.window?.duration === 300 && String(it.window?.timeUnit || '').includes('MINUTE')) {
      windows.push(mk('5小时', 300 * 60, it.detail.limit, it.detail.used, it.detail.resetTime));
    }
  }
  // 周窗口：顶层 usage（resetTime 约 7 天后）
  if (j.usage && j.usage.limit != null) {
    windows.push(mk('7天', 7 * 86400, j.usage.limit, j.usage.used, j.usage.resetTime));
  }
  return { windows, latencyMs };
}

function listWireFiles() {
  const out = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  let lines = [];
  try { lines = fs.readFileSync(SESSION_INDEX, 'utf8').split('\n'); } catch { return out; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let sessionDir, workDir;
    try { ({ sessionDir, workDir } = JSON.parse(line)); } catch { continue; }
    if (!sessionDir) continue;
    let agents = [];
    try { agents = fs.readdirSync(path.join(sessionDir, 'agents')); } catch { continue; }
    for (const a of agents) {
      const p = path.join(sessionDir, 'agents', a, 'wire.jsonl');
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) out.push({ path: p, size: st.size, cwd: workDir || null });
      } catch {}
    }
  }
  return out;
}

function loadScanCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.v !== 2) throw new Error('v1→v2: rows 增加 cwd 维度，全量重扫');
    return c;
  } catch { return { v: 2, files: {}, rows: {} } };
}
function saveScanCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

function scan() {
  const cache = loadScanCache();
  const files = listWireFiles();
  const keepAfter = localDate(Date.now() - SCAN_DAYS * 86400000);
  for (const f of files) {
    const rec = cache.files[f.path];
    const offset = rec && rec.size <= f.size ? rec.offset : 0;
    if (offset >= f.size) { if (rec) rec.size = f.size; continue; }
    const r = rec || (cache.files[f.path] = { offset: 0, size: 0 });
    r.offset = readNewLines(f.path, offset, (line) => {
      if (!line.includes('usage.record')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.type !== 'usage.record' || j.usageScope !== 'turn' || !j.usage || !j.time) return;
      const date = localDate(j.time);
      if (date < keepAfter) return;
      const model = j.model || 'unknown';
      const key = `${date}|${model}|${f.cwd || ''}`;
      const row = cache.rows[key] || (cache.rows[key] = { date, model, cwd: f.cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      row.input += j.usage.inputOther || 0;
      row.output += j.usage.output || 0;
      row.cacheRead += j.usage.inputCacheRead || 0;
      row.cacheWrite += j.usage.inputCacheCreation || 0;
    });
    r.size = f.size;
  }
  for (const k of Object.keys(cache.rows)) if (cache.rows[k].date < keepAfter) delete cache.rows[k];
  for (const p of Object.keys(cache.files)) if (!files.some((f) => f.path === p)) delete cache.files[p];
  saveScanCache(cache);
  return Object.values(cache.rows);
}

export function createKimiAdapter() {
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastLatency = 0, lastOk = 0;
  let lastGood = null; // { data, ts } 上次成功的配额快照
  const QUOTA_TTL = 60_000;
  const STALE_MAX = 30 * 60_000; // 连续失败 30 分钟才转 offline

  return {
    id: 'kimi', name: 'Kimi Code', color: '#22d3ee',
    warm() { this.quota().catch(() => {}); rowsCache.warm(); },
    async quota() {
      // 从未跑过 Kimi Code：目录都不存在 → 不是故障，不进告警横幅
      if (!fs.existsSync(KIMI_DIR)) return { status: 'unconfigured', kind: 'windows', windows: [], note: '未检测到 Kimi Code 使用记录' };
      // 60s 内直接返上次成功快照（测试模式下不走 TTL，让失败可被构造）
      if (!TEST_MODE && lastGood && Date.now() - lastGood.ts < QUOTA_TTL) {
        return { status: 'online', kind: 'windows', windows: lastGood.data.windows };
      }
      try {
        const q = await fetchQuotaRaw();
        lastGood = { data: q, ts: Date.now() };
        lastLatency = q.latencyMs; lastOk = Date.now();
        return { status: 'online', kind: 'windows', windows: q.windows };
      } catch (e) {
        // 失败降级：有 30 分钟内的成功快照 → stale（保留旧数据 + 副标提示），否则 offline
        if (lastGood && Date.now() - lastGood.ts < STALE_MAX) {
          const mins = Math.max(1, Math.round((Date.now() - lastGood.ts) / 60000));
          return {
            status: 'stale', kind: 'windows', windows: lastGood.data.windows,
            note: `数据为 ${mins} 分钟前 · 查询失败重试中`,
          };
        }
        throw e; // server 兜底为 offline
      }
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      if (!fs.existsSync(KIMI_DIR)) return { state: 'unconfigured', latencyMs: 0 };
      const state = lastOk ? (Date.now() - lastOk < STALE_MAX ? 'operational' : 'degraded') : 'degraded';
      return { state, latencyMs: Math.round(lastLatency) };
    },
  };
}
