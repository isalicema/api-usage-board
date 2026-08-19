// adapters/codex.mjs — Codex 渠道
// 配额：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 尾部找最新 token_count 事件的
//       payload.rate_limits（官方窗口状态：used_percent / window_minutes / resets_at）。
// Token：同一事件 payload.info.last_token_usage（本 turn 增量），增量扫描。
//        注意：单文件最大 500M+，必须分块读（readNewLines）；解析位置按 path+size
//        持久化到 server/.cache/codex-scan.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { swr, staleGate } from '../ttl.mjs';
import { readNewLines, localDate } from '../scan-util.mjs';

const HOME = os.homedir();
const SESSIONS = path.join(HOME, '.codex', 'sessions');
const AUTH_FILE = path.join(HOME, '.codex', 'auth.json');
const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'; // 官方客户端行为，未公开接口，可能漂移
const CACHE_FILE = fileURLToPath(new URL('../.cache/codex-scan.json', import.meta.url));
const SCAN_DAYS = 110; // 覆盖到 2026-05-03（archived_sessions 最早）+ 热力图 84 天余量
const ARCHIVED = path.join(HOME, '.codex', 'archived_sessions'); // 扁平目录，文件名带日期

// 测试钩子：AUB_TEST_CODEX_FAIL_AFTER=N 时第 N+1 次起配额查询必失败（wham+rollout 都断）
const TEST_FAIL_AFTER = parseInt(process.env.AUB_TEST_CODEX_FAIL_AFTER || '', 10);
const TEST_MODE = !isNaN(TEST_FAIL_AFTER);
let testCalls = 0;

function readCodexAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const token = j.tokens?.access_token || j.access_token || null;
    if (!token) return null;
    let accountId = j.tokens?.account_id || null;
    if (!accountId) { // 从 access_token 的 JWT payload claim 解
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        accountId = payload['https://api.openai.com/auth.chatgpt_account_id'] || null;
      } catch {}
    }
    return { token, accountId };
  } catch { return null; }
}

async function fetchWham() {
  const auth = readCodexAuth();
  if (!auth) throw new Error('no codex credentials');
  const res = await fetch(WHAM_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      originator: 'Codex Desktop',
      'OAI-Product-Sku': 'CODEX',
      Accept: 'application/json',
      ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`wham HTTP ${res.status}`);
  const j = await res.json();
  const now = Math.floor(Date.now() / 1000);
  const mk = (w) => {
    if (!w) return null;
    const windowSec = w.limit_window_seconds || 0;
    const resetInSec = Math.max(0, (w.reset_at || 0) - now);
    return {
      label: windowSec <= 12 * 3600 ? '5小时' : '7天', // ≤12h 当 Session 档，否则 Weekly 档
      windowSec,
      usedPct: w.used_percent,
      timePct: windowSec ? Math.min(100, Math.round((1 - resetInSec / windowSec) * 100)) : null,
      resetInSec,
    };
  };
  const rl = j.rate_limit || {};
  const windows = [mk(rl.primary_window), mk(rl.secondary_window)].filter(Boolean);
  if (!windows.length) throw new Error('wham: no windows');
  return { windows, source: 'wham', note: j.plan_type ? `${j.plan_type} 订阅` : undefined };
}

function listSessionFiles() {
  const out = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  // 注意：截断必须按内容日期（目录/文件名里的日期），不能按 mtime——
  // 老会话文件不会再被 touch，mtime 截断会把 5/6 月的历史整批漏掉（修过的 bug）
  const push = (p, dateMs) => {
    if (dateMs + 86400000 < cutoff) return; // 整天都早于窗口才跳
    try {
      const st = fs.statSync(p);
      out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  };
  let years = [];
  try { years = fs.readdirSync(SESSIONS); } catch { years = []; }
  for (const y of years) {
    const yDir = path.join(SESSIONS, y);
    let months = [];
    try { months = fs.readdirSync(yDir); } catch { continue; }
    for (const m of months) {
      const mDir = path.join(yDir, m);
      let days = [];
      try { days = fs.readdirSync(mDir); } catch { continue; }
      for (const d of days) {
        const dDir = path.join(mDir, d);
        const dayMs = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
        let files = [];
        try { files = fs.readdirSync(dDir); } catch { continue; }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) push(path.join(dDir, f), dayMs);
        }
      }
    }
  }
  // archived_sessions：扁平目录，rollout-YYYY-MM-DDT… 文件名带日期
  try {
    for (const f of fs.readdirSync(ARCHIVED)) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const m = f.match(/^rollout-(\d{4})-(\d{2})-(\d{2})/);
      if (m) push(path.join(ARCHIVED, f), Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`));
    }
  } catch {}
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function loadScanCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.v !== 3) throw new Error('v2→v3: 窗口扩到 110 天 + archived_sessions，全量重扫');
    return c;
  } catch { return { v: 3, files: {}, rows: {} } };
}
function saveScanCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

function scan() {
  const t0 = Date.now();
  const cache = loadScanCache();
  const files = listSessionFiles();
  const keepRowsAfter = localDate(Date.now() - SCAN_DAYS * 86400000);

  for (const f of files) {
    const rec = cache.files[f.path];
    const offset = rec && rec.size <= f.size ? rec.offset : 0; // 变小了视为重写，从头扫
    if (offset >= f.size) { if (rec) rec.size = f.size; continue; }
    const r = rec || (cache.files[f.path] = { offset: 0, size: 0, model: null, cwd: null });
    r.offset = readNewLines(f.path, offset, (line) => {
      if (!line.includes('token_count') && !line.includes('turn_context')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'turn_context') { // payload 里同时带 model 和 cwd（实测字段名）
        if (j.payload?.model) r.model = j.payload.model;
        if (j.payload?.cwd) r.cwd = j.payload.cwd;
        return;
      }
      if (j.type !== 'event_msg' || j.payload?.type !== 'token_count') return;
      const u = j.payload.info?.last_token_usage;
      if (!u || !j.timestamp) return;
      const date = localDate(Date.parse(j.timestamp));
      if (date < keepRowsAfter) return;
      const key = `${date}|${r.model || 'unknown'}|${r.cwd || ''}`;
      const row = cache.rows[key] || (cache.rows[key] = { date, model: r.model || 'unknown', cwd: r.cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      row.input += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
      row.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
      row.cacheRead += u.cached_input_tokens || 0;
      row.cacheWrite += u.cache_write_input_tokens || 0;
    });
    r.size = f.size;
  }

  // 滚动清理
  for (const k of Object.keys(cache.rows)) if (cache.rows[k].date < keepRowsAfter) delete cache.rows[k];
  for (const p of Object.keys(cache.files)) if (!files.some((f) => f.path === p)) delete cache.files[p];
  saveScanCache(cache);
  return { rows: Object.values(cache.rows), scanMs: Date.now() - t0 };
}

const WINDOW_LABEL = (min) => (min === 300 ? '5小时' : min === 10080 ? '7天' : `${Math.round(min / 60)}h`);

// 配额：最近几天的文件尾部找最新 rate_limits（每文件只读尾 256KB）
function readQuota() {
  const files = listSessionFiles().slice(-40).reverse(); // 新的在前
  for (const f of files.slice(0, 12)) {
    let tail;
    try {
      const st = fs.statSync(f.path);
      const start = Math.max(0, st.size - 256 * 1024);
      const fd = fs.openSync(f.path, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      tail = buf.toString('utf8');
    } catch { continue; }
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('rate_limits')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'event_msg' || j.payload?.type !== 'token_count') continue;
      const rl = j.payload.rate_limits;
      const wins = [rl?.primary, rl?.secondary].filter(Boolean);
      if (!wins.length) continue;
      const now = Date.now();
      const windows = wins.map((w) => {
        const windowSec = (w.window_minutes || 0) * 60;
        const resetInSec = Math.max(0, (w.resets_at || 0) - Math.floor(now / 1000));
        return {
          label: WINDOW_LABEL(w.window_minutes),
          windowSec,
          usedPct: w.used_percent,
          timePct: windowSec ? Math.min(100, Math.round((1 - resetInSec / windowSec) * 100)) : null,
          resetInSec,
        };
      });
      return { windows, ts: Date.parse(j.timestamp) || now };
    }
  }
  return null;
}

export function createCodexAdapter() {
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastScanMs = 0, lastScanOk = 0;

  // 配额降级链：wham 直连 → rollout 日志解析 → offline（套 stale 机制）
  const gate = staleGate(60_000, 30 * 60_000, async () => {
    if (TEST_MODE && ++testCalls > TEST_FAIL_AFTER) throw new Error('simulated failure (AUB_TEST_CODEX_FAIL_AFTER)');
    try {
      return await fetchWham();
    } catch {
      const q = readQuota();
      if (!q || !q.windows.length) throw new Error('rollout: no rate_limits');
      return { windows: q.windows, source: 'rollout' };
    }
  });

  return {
    id: 'codex', name: 'Codex', color: '#b78cff',
    warm() { gate({}).catch(() => {}); rowsCache.warm(); },
    async quota() {
      const r = await gate({ bypassTtl: TEST_MODE });
      const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
      if (r.stale) {
        const mins = Math.max(1, Math.round(r.ageMs / 60000));
        return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
      }
      return { ...base, status: 'online' };
    },
    async usageRows() {
      const t0 = Date.now();
      const r = await rowsCache.get();
      lastScanMs = Date.now() - t0; lastScanOk = Date.now();
      return r.rows;
    },
    health() {
      return {
        state: lastScanOk ? 'operational' : 'degraded',
        latencyMs: Math.round(lastScanMs),
      };
    },
  };
}
