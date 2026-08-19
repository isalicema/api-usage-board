// adapters/deepseek.mjs — DeepSeek 渠道
// 余额：GET https://api.deepseek.com/user/balance（Bearer key 从 ~/.dsh/.credentials.yaml
//       的 DEEPSEEK_API_KEY 行手解，不引 yaml 库；key 只进内存，绝不外泄）。
// Token：~/.dsh/sessions/**\/*.jsonl.zstd（zstd -dc 解压），chunk.type=="usage" 事件；
//        按 path+mtime+size 持久化缓存，只重解变化过的文件。用量少、序列稀疏是正常的。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { swr } from '../ttl.mjs';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const CREDS = path.join(HOME, '.dsh', '.credentials.yaml');
const SESSIONS = path.join(HOME, '.dsh', 'sessions');
const CACHE_FILE = fileURLToPath(new URL('../.cache/deepseek-scan.json', import.meta.url));

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readApiKey() {
  try {
    for (const line of fs.readFileSync(CREDS, 'utf8').split('\n')) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return null;
}

async function fetchBalanceRaw() {
  const key = readApiKey();
  if (!key) throw new Error('no deepseek key');
  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`deepseek balance HTTP ${res.status}`);
  const j = await res.json();
  const info = (j.balance_infos || [])[0];
  if (!info) throw new Error('no balance_infos');
  return { amount: parseFloat(info.total_balance), currency: info.currency || 'CNY', latencyMs };
}

function walkZstd(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkZstd(p, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}

// ~/.dsh/sessions/<编码工作区>/<session-uuid>/session.jsonl.zstd
// 编码：-- 包裹，- 代替 /，~00XX 为 ASCII 转义（如 ~0020=空格）。best-effort 解码。
function decodeDshDir(p) {
  const rel = path.relative(SESSIONS, p);
  const enc = rel.split(path.sep)[0] || '';
  const inner = enc.replace(/^--+|--+$/g, '');
  const unesc = inner.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return '/' + unesc.replace(/-/g, '/').replace(/^\/+/, '');
}

function loadScanCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.v !== 2) throw new Error('v1→v2: rows 增加 cwd 维度，全量重扫');
    return c;
  } catch { return { v: 2, files: {} } };
}
function saveScanCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

async function scan() {
  const cache = loadScanCache();
  const files = walkZstd(SESSIONS, []);
  const seen = new Set(files);
  for (const p of Object.keys(cache.files)) if (!seen.has(p)) delete cache.files[p];

  for (const p of files) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const rec = cache.files[p];
    if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) continue; // 未变
    const cwd = decodeDshDir(p);
    let text;
    try {
      const { stdout } = await execFileP('zstd', ['-dc', p], { maxBuffer: 64 * 1024 * 1024 });
      text = stdout;
    } catch { continue; }
    const rows = {};
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const chunk = j.data?.chunk;
      if (chunk?.type !== 'usage' || !chunk.usage || !j.time) continue;
      const date = localDate(j.time);
      const row = rows[date] || (rows[date] = { date, model: 'deepseek', cwd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      row.input += chunk.usage.inputTokens || 0;
      row.output += (chunk.usage.outputTokens || 0) + (chunk.usage.reasoningTokens || 0);
      row.cacheRead += chunk.usage.cacheReadTokens || 0;
    }
    cache.files[p] = { mtimeMs: st.mtimeMs, size: st.size, rows: Object.values(rows) };
  }
  saveScanCache(cache);
  // 汇总：date|model|cwd 聚合
  const agg = {};
  for (const f of Object.values(cache.files)) {
    for (const r of f.rows || []) {
      const key = `${r.date}|${r.model}|${r.cwd || ''}`;
      const a = agg[key] || (agg[key] = { date: r.date, model: r.model, cwd: r.cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      a.input += r.input; a.output += r.output; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite;
    }
  }
  return Object.values(agg);
}

export function createDeepseekAdapter() {
  const quotaCache = swr(60_000, fetchBalanceRaw);
  const rowsCache = swr(10 * 60_000, scan);
  let lastLatency = 0, lastOk = 0;

  return {
    id: 'deepseek', name: 'DeepSeek', color: '#34d399',
    warm() { quotaCache.warm(); rowsCache.warm(); },
    async quota() {
      const q = await quotaCache.get();
      lastLatency = q.latencyMs; lastOk = Date.now();
      return { status: 'online', kind: 'balance', balance: { amount: q.amount, currency: q.currency } };
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
