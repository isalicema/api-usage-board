// adapters/claude.mjs — Claude Code 渠道
// 配额降级链：官方直连接口（api.anthropic.com/api/oauth/usage，跟随官方客户端行为，未公开、可能漂移）
//   → ccusage 估算（副标注明）→ offline。全程套 stale 机制（失败保留 ≤30min 旧快照）。
// 凭证优先级：env CLAUDE_CODE_OAUTH_TOKEN → ~/.claude/.credentials.json → Keychain
//   （security find-generic-password -s "Claude Code-credentials"，全 hex 先解码）。
// Token 刷新：不实现写回——Claude Code CLI 自身也刷新并写回同一凭证，refresh_token 轮换
//   存在并发冲突风险；只做 401 重读凭证重试一次。详见 README 遗留。
// 安全红线：token 只进内存，绝不进日志/响应。
// Token 序列仍走 ccusage daily（只取 claude-* 模型，ccusage 会混入 kimi 的 k3 等）。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { swr, staleGate } from '../ttl.mjs';
import { readNewLines, localDate } from '../scan-util.mjs';

const execFileP = promisify(execFile);
const NPX = path.join(path.dirname(process.execPath), 'npx');
const TTL = 10 * 60_000; // ccusage 全量扫慢，10 分钟 TTL
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// 测试钩子：AUB_TEST_CLAUDE_FAIL_AFTER=N 时第 N+1 次起配额查询必失败（直连+回退都断）
const TEST_FAIL_AFTER = parseInt(process.env.AUB_TEST_CLAUDE_FAIL_AFTER || '', 10);
const TEST_MODE = !isNaN(TEST_FAIL_AFTER);
let testCalls = 0;

function readClaudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    const t = j?.claudeAiOauth?.accessToken;
    if (t) return t;
  } catch {}
  try {
    let raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8', timeout: 5000,
    }).trim();
    if (/^[0-9a-fA-F]+$/.test(raw)) raw = Buffer.from(raw, 'hex').toString('utf8'); // hex 编码的 JSON
    const t = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (t) return t;
  } catch {}
  return null;
}

async function directCall(token) {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.170',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  return res;
}

async function fetchDirect(subscriptionHint) {
  let token = readClaudeToken();
  if (!token) throw new Error('no claude credentials');
  let res = await directCall(token);
  if (res.status === 401) { // 凭证可能刚被 CLI 轮换，重读再试一次
    const t2 = readClaudeToken();
    if (t2 && t2 !== token) res = await directCall(t2);
  }
  if (!res.ok) throw new Error(`claude usage HTTP ${res.status}`);
  const j = await res.json();
  const now = Date.now();
  const mk = (label, windowSec, w) => {
    if (!w) return null;
    const resetInSec = w.resets_at ? Math.max(0, Math.round((Date.parse(w.resets_at) - now) / 1000)) : null;
    return {
      label, windowSec,
      usedPct: typeof w.utilization === 'number' ? Math.round(w.utilization * 10) / 10 : null,
      timePct: resetInSec != null && windowSec ? Math.min(100, Math.round((1 - resetInSec / windowSec) * 100)) : null,
      resetInSec,
    };
  };
  const windows = [
    mk('5小时', 5 * 3600, j.five_hour),
    mk('7天', 7 * 86400, j.seven_day),
  ].filter(Boolean);
  if (!windows.length) throw new Error('claude usage: no windows');
  const plan = subscriptionHint ? subscriptionHint[0].toUpperCase() + subscriptionHint.slice(1) : null;
  return { windows, source: 'direct', note: plan ? `${plan} 订阅` : undefined };
}

async function runCcusage(...args) {
  const { stdout } = await execFileP(NPX, ['-y', 'ccusage@latest', ...args, '--json'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
    // npx 是 `#!/usr/bin/env node` 脚本：双击启动时 PATH 可能缺 node 目录，补上
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` },
  });
  return JSON.parse(stdout);
}

// ---- Token 序列：本地扫描 ~/.claude/projects/*/\*.jsonl（带 cwd，供按项目统计）----
// 228M 全量首轮扫一次（分块读），之后增量；按 message.id 去重（流式分片重复），
// 过滤 model=="<synthetic>"。ccusage daily 仍保留给配额兜底/对比日志。
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SCAN_CACHE_FILE = fileURLToPath(new URL('../.cache/claude-scan.json', import.meta.url));
const SCAN_DAYS = 95; // 覆盖热力图 84 天 + 余量

function loadLocalScan() {
  try {
    const c = JSON.parse(fs.readFileSync(SCAN_CACHE_FILE, 'utf8'));
    if (c.v !== 1) throw new Error('缓存无版本号：rows 曾被旧窗口裁掉，全量重扫');
    return c;
  } catch { return { v: 1, files: {}, rows: {} } };
}
function saveLocalScan(c) {
  try {
    fs.mkdirSync(path.dirname(SCAN_CACHE_FILE), { recursive: true });
    fs.writeFileSync(SCAN_CACHE_FILE, JSON.stringify(c));
  } catch {}
}

function scanLocal() {
  const cache = loadLocalScan();
  const files = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  let projects = [];
  try { projects = fs.readdirSync(CLAUDE_PROJECTS); } catch { projects = []; }
  for (const proj of projects) {
    let fs2 = [];
    try { fs2 = fs.readdirSync(path.join(CLAUDE_PROJECTS, proj)); } catch { continue; }
    for (const f of fs2) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(CLAUDE_PROJECTS, proj, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) files.push({ path: p, size: st.size });
      } catch {}
    }
  }

  const keepAfter = localDate(Date.now() - SCAN_DAYS * 86400000);
  for (const f of files) {
    const rec = cache.files[f.path];
    const fresh = !(rec && rec.size <= f.size);
    const offset = fresh ? 0 : rec.offset;
    if (offset >= f.size) { if (rec) rec.size = f.size; continue; }
    const r = rec || (cache.files[f.path] = {});
    const seen = new Set(fresh ? [] : (r.seenIds || [])); // message.id 去重（流式分片）
    r.offset = readNewLines(f.path, offset, (line) => {
      if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const msg = j.message;
      if (!msg?.usage || !j.timestamp) return;
      if (msg.model === '<synthetic>') return;
      if (msg.id) {
        if (seen.has(msg.id)) return;
        seen.add(msg.id);
      }
      const date = localDate(Date.parse(j.timestamp));
      if (date < keepAfter) return;
      const key = `${date}|${msg.model || 'unknown'}|${j.cwd || ''}`;
      const row = cache.rows[key] || (cache.rows[key] = { date, model: msg.model || 'unknown', cwd: j.cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      row.input += msg.usage.input_tokens || 0;
      row.output += msg.usage.output_tokens || 0;
      row.cacheRead += msg.usage.cache_read_input_tokens || 0;
      row.cacheWrite += msg.usage.cache_creation_input_tokens || 0;
    });
    r.seenIds = [...seen];
    r.size = f.size;
  }
  for (const k of Object.keys(cache.rows)) if (cache.rows[k].date < keepAfter) delete cache.rows[k];
  for (const p of Object.keys(cache.files)) if (!files.some((f) => f.path === p)) delete cache.files[p];
  saveLocalScan(cache);
  return Object.values(cache.rows);
}

export function createClaudeAdapter() {
  const blocksCache = swr(TTL, () => runCcusage('blocks'));
  const dailyCache = swr(TTL, () => runCcusage('daily'));
  let lastScanMs = 0, lastOk = 0;
  let lastCompareLog = null; // 直连 vs ccusage 对比日志去重

  async function fetchCcusageQuota() {
    const [blocksJ, dailyJ] = await Promise.all([blocksCache.get(), dailyCache.get()]);
    const now = Date.now();
    const blocks = blocksJ.blocks || [];
    const active = blocks.find((b) => b.isActive);
    let maxBlock = 1;
    for (const b of blocks) maxBlock = Math.max(maxBlock, b.totalTokens || 0, b.projection?.totalTokens || 0);

    const days = (dailyJ.daily || []).map((d) => ({
      date: d.period,
      tokens: (d.modelBreakdowns || [])
        .filter((m) => /^claude/i.test(m.modelName))
        .reduce((s, m) => s + m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens, 0),
    }));
    let maxRoll7 = 1;
    for (let i = 0; i < days.length; i++) {
      let s = 0;
      for (let k = Math.max(0, i - 6); k <= i; k++) s += days[k].tokens;
      maxRoll7 = Math.max(maxRoll7, s);
    }
    const last7 = days.slice(-7).reduce((s, d) => s + d.tokens, 0);

    const windows = [];
    if (active) {
      const start = Date.parse(active.startTime), end = Date.parse(active.endTime);
      const windowSec = Math.round((end - start) / 1000);
      windows.push({
        label: '5小时', windowSec,
        usedPct: Math.round((active.totalTokens / maxBlock) * 1000) / 10,
        timePct: Math.min(100, Math.round(((now - start) / (end - start)) * 100)),
        resetInSec: Math.max(0, Math.round((end - now) / 1000)),
      });
    }
    windows.push({
      label: '7天', windowSec: 7 * 86400,
      usedPct: Math.round((last7 / maxRoll7) * 1000) / 10,
      timePct: null, resetInSec: null,
    });
    return { windows, source: 'ccusage', note: '限额为 ccusage 估算', est7d: Math.round((last7 / maxRoll7) * 100) };
  }

  // 组合：直连 → ccusage；直连成功时顺便打一条与 ccusage 估算的对比日志（ccusage 走缓存，不额外扫）
  async function fetchCombined() {
    if (TEST_MODE && ++testCalls > TEST_FAIL_AFTER) throw new Error('simulated failure (AUB_TEST_CLAUDE_FAIL_AFTER)');
    try {
      const d = await fetchDirect(readSubscriptionHint());
      dailyCache.get().then((dailyJ) => {
        try {
          const days = (dailyJ.daily || []).map((x) => ({
            date: x.period,
            tokens: (x.modelBreakdowns || []).filter((m) => /^claude/i.test(m.modelName))
              .reduce((s, m) => s + m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens, 0),
          }));
          let maxRoll7 = 1;
          for (let i = 0; i < days.length; i++) {
            let s = 0;
            for (let k = Math.max(0, i - 6); k <= i; k++) s += days[k].tokens;
            maxRoll7 = Math.max(maxRoll7, s);
          }
          const est = Math.round((days.slice(-7).reduce((s, x) => s + x.tokens, 0) / maxRoll7) * 100);
          const direct7d = d.windows.find((w) => w.label === '7天')?.usedPct;
          const line = `[claude] 直连 7天=${direct7d}% vs ccusage 估算 7天=${est}%（直连为准）`;
          if (line !== lastCompareLog) { console.log(line); lastCompareLog = line; } // 只在变化时打
        } catch {}
      }).catch(() => {});
      return d;
    } catch {
      return fetchCcusageQuota();
    }
  }

  const gate = staleGate(60_000, 30 * 60_000, fetchCombined);
  const rowsCache = swr(5 * 60_000, async () => scanLocal());

  // subscriptionType 从凭证里顺手取（仅用于显示，token 不出进程）
  function readSubscriptionHint() {
    try {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null;
      const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
      return j?.claudeAiOauth?.subscriptionType || null;
    } catch {}
    try {
      let raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 }).trim();
      if (/^[0-9a-fA-F]+$/.test(raw)) raw = Buffer.from(raw, 'hex').toString('utf8');
      return JSON.parse(raw)?.claudeAiOauth?.subscriptionType || null;
    } catch {}
    return null;
  }

  return {
    id: 'claude', name: 'Claude Code', color: '#5aa9ff',
    warm() { gate({}).catch(() => {}); blocksCache.warm(); dailyCache.warm(); rowsCache.warm(); },
    async quota() {
      const r = await gate({ bypassTtl: TEST_MODE });
      lastOk = Date.now();
      const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
      if (r.stale) {
        const mins = Math.max(1, Math.round(r.ageMs / 60000));
        return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
      }
      return { ...base, status: 'online' };
    },

    async usageRows() {
      const t0 = Date.now();
      const rows = await rowsCache.get(); // 本地扫描（带 cwd）；ccusage daily 只用于配额兜底
      lastScanMs = Date.now() - t0;
      return rows;
    },

    health() {
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastScanMs) };
    },
  };
}
