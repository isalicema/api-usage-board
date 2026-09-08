// adapters/antigravity.mjs — Antigravity（agy）渠道：配额 + 本地 Token 序列
// 配额：agy 运行时起本地 language server——从最新 cli-*.log 正则端口，POST RetrieveUserQuotaSummary。
//       agy 不在跑 → dormant（灰 pill「未运行」，不进告警横幅）。
// Token 序列：扫描 ~/.gemini/antigravity-cli/conversations/*.db 的 gen_metadata 表（protobuf 编码），
//             结合 ~/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/transcript.jsonl
//             提取各 turn 的 input / output / cacheRead token 及模型名称。
//             增量缓存至 server/.cache/antigravity-scan.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { swr, staleGate } from '../ttl.mjs';
import { localDate } from '../scan-util.mjs';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'log');
const CONV_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'conversations');
const BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const CACHE_FILE = fileURLToPath(new URL('../.cache/antigravity-scan.json', import.meta.url));
const SNAPSHOT_MAX_AGE = 24 * 3600_000;
const SCAN_DAYS = 110;

function findPorts() {
  let files = [];
  try {
    files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^cli-.*\.log$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
  const ports = [];
  for (const { f } of files.slice(0, 3)) { // 最新 3 个日志
    try {
      const text = fs.readFileSync(path.join(LOG_DIR, f), 'utf8');
      for (const m of text.matchAll(/Language server listening on random port at (\d+)/g)) {
        const p = Number(m[1]);
        if (!ports.includes(p)) ports.push(p);
      }
    } catch {}
  }
  return ports;
}

async function fetchQuotaFromLS() {
  const ports = findPorts();
  if (!ports.length) throw new Error('no language server port in logs');
  for (const port of ports) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(500) },
      );
      if (!res.ok) continue;
      const j = await res.json();
      const groups = j.response?.groups || [];
      const now = Date.now();
      const windows = [];
      for (const g of groups) {
        // 接口按模型分组（Gemini Models / Claude and GPT models），各有独立的 weekly+5h 池。
        // 平铺时必须带组名，否则 UI 出现两行一样的「7天/5小时」，且 resetDeadlines 键冲突。
        const tag = /gemini/i.test(g.displayName || '') ? 'Gemini'
          : /claude|gpt/i.test(g.displayName || '') ? 'Claude/GPT'
          : (g.displayName || '').split(/\s+/)[0] || 'agy';
        for (const b of g.buckets || []) {
          const weekly = b.window === 'weekly';
          const windowSec = weekly ? 7 * 86400 : 5 * 3600;
          const resetInSec = b.resetTime ? Math.max(0, Math.round((Date.parse(b.resetTime) - now) / 1000)) : null;
          const remaining = Number(b.remainingFraction);
          windows.push({
            label: `${tag} ${weekly ? '7天' : '5小时'}`,
            windowSec,
            usedPct: isFinite(remaining) ? Math.round((1 - remaining) * 1000) / 10 : null, // remaining → 已用
            timePct: resetInSec != null ? Math.min(100, Math.round((1 - resetInSec / windowSec) * 100)) : null,
            resetInSec,
            bucket: b.displayName || b.bucketId || null,
          });
        }
      }
      if (!windows.length) continue;
      return { windows, source: 'language-server' };
    } catch { continue; } // 端口死了就试下一个
  }
  throw new Error('agy language server unreachable');
}

// ---- Token 序列扫描：解析 gen_metadata Protobuf 与 transcript 日志 ----

function parseVarint(buf, pos) {
  let val = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    val += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [val, pos];
}

// 逆向自 gen_metadata protobuf: field 1 (Response) -> field 4 (Usage) -> field 1 (in), field 3 (out), field 5 (cache)
function parseTokensFromProto(buf) {
  let pos = 0, f1 = null;
  while (pos < buf.length) {
    const [key, np] = parseVarint(buf, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) { const [, n] = parseVarint(buf, pos); pos = n; }
    else if (wire === 2) {
      const [len, n] = parseVarint(buf, pos); pos = n;
      const val = buf.subarray(pos, pos + len); pos += len;
      if (fnum === 1) f1 = val;
    } else break;
  }
  if (!f1) return null;

  pos = 0; let f4 = null;
  while (pos < f1.length) {
    const [key, np] = parseVarint(f1, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) { const [, n] = parseVarint(f1, pos); pos = n; }
    else if (wire === 2) {
      const [len, n] = parseVarint(f1, pos); pos = n;
      const val = f1.subarray(pos, pos + len); pos += len;
      if (fnum === 4) f4 = val;
    } else break;
  }
  if (!f4) return null;

  pos = 0; let input = 0, output = 0, cacheRead = 0;
  while (pos < f4.length) {
    const [key, np] = parseVarint(f4, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) {
      const [val, n] = parseVarint(f4, pos); pos = n;
      if (fnum === 1) input = val;
      else if (fnum === 3) output = val;
      else if (fnum === 5) cacheRead = val;
    } else if (wire === 2) {
      const [len, n] = parseVarint(f4, pos); pos = n;
      pos += len;
    } else break;
  }
  return { input, output, cacheRead };
}

async function readDbEntries(dbPath) {
  const entries = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata').all();
    for (const r of rows) {
      entries.push({ idx: r.idx, data: Buffer.from(r.data) });
    }
    db.close();
    return entries;
  } catch {}

  try {
    const out = execFileSync('/usr/bin/sqlite3', [dbPath, 'SELECT idx, quote(data) FROM gen_metadata;'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      const sep = line.indexOf('|');
      if (sep === -1) continue;
      const idx = Number(line.slice(0, sep));
      const hexStr = line.slice(sep + 1).trim();
      if (!hexStr.startsWith("X'") || !hexStr.endsWith("'")) continue;
      entries.push({ idx, data: Buffer.from(hexStr.slice(2, -1), 'hex') });
    }
  } catch {}
  return entries;
}

function readTranscriptInfo(cid) {
  const tfile = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'transcript.jsonl');
  const stepDates = new Map();
  let cwd = null;
  if (!fs.existsSync(tfile)) return { stepDates, cwd };
  try {
    const content = fs.readFileSync(tfile, 'utf8');
    const lines = content.split('\n');
    for (const l of lines) {
      if (!l.includes('"created_at"')) continue;
      try {
        const j = JSON.parse(l);
        if (j.step_index != null && j.created_at) {
          stepDates.set(j.step_index, localDate(Date.parse(j.created_at)));
        }
        if (!cwd && j.content && j.content.includes('active workspaces')) {
          const m = j.content.match(/The mapping is shown as follows[^\n]*\n([^\s\-]+)/);
          if (m) cwd = m[1].trim();
        }
      } catch {}
    }
  } catch {}
  return { stepDates, cwd };
}

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.v === 1 && c.files && c.rows) return c;
  } catch {}
  return { v: 1, files: {}, rows: {} };
}

function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

async function scan() {
  const t0 = Date.now();
  let files = [];
  try {
    files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.db'));
  } catch { return { rows: [], scanMs: 0 }; }

  const cutoffMs = Date.now() - SCAN_DAYS * 86400000;
  const keepAfter = localDate(cutoffMs);
  const cache = loadCache();
  const activePaths = new Set();
  const rowsMap = {};

  for (const f of files) {
    const dbPath = path.join(CONV_DIR, f);
    activePaths.add(dbPath);
    let st;
    try { st = fs.statSync(dbPath); } catch { continue; }
    if (st.mtimeMs < cutoffMs) continue;

    const cachedFile = cache.files[dbPath];
    if (cachedFile && cachedFile.mtimeMs === st.mtimeMs && cachedFile.size === st.size && cachedFile.rows) {
      for (const r of cachedFile.rows) {
        if (r.date < keepAfter) continue;
        const key = `${r.date}|${r.model}|${r.cwd || ''}`;
        const row = rowsMap[key] || (rowsMap[key] = {
          date: r.date, model: r.model, cwd: r.cwd || null,
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        });
        row.input += r.input;
        row.output += r.output;
        row.cacheRead += r.cacheRead;
        row.cacheWrite += (r.cacheWrite || 0);
      }
      continue;
    }

    const cid = f.replace(/\.db$/, '');
    const fallbackDate = localDate(st.mtimeMs);
    const { stepDates, cwd } = readTranscriptInfo(cid);
    const entries = await readDbEntries(dbPath);
    const fileRows = [];

    for (const e of entries) {
      const tok = parseTokensFromProto(e.data);
      if (!tok) continue;
      const date = stepDates.get(e.idx) || fallbackDate;
      if (date < keepAfter) continue;

      const m = e.data.toString('latin1').match(/(gemini-[\w\.\-]+|claude-[\w\.\-]+|gpt-[\w\.\-]+)/);
      const model = m ? m[1] : 'gemini';
      const key = `${date}|${model}|${cwd || ''}`;
      const row = rowsMap[key] || (rowsMap[key] = {
        date, model, cwd: cwd || null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      });
      row.input += tok.input;
      row.output += tok.output;
      row.cacheRead += tok.cacheRead;

      fileRows.push({
        date, model, cwd: cwd || null, input: tok.input, output: tok.output, cacheRead: tok.cacheRead,
      });
    }

    cache.files[dbPath] = { mtimeMs: st.mtimeMs, size: st.size, rows: fileRows };
  }

  // 清理不存在的旧缓存
  for (const p of Object.keys(cache.files)) {
    if (!activePaths.has(p)) delete cache.files[p];
  }
  cache.rows = rowsMap;
  saveCache(cache);

  return { rows: Object.values(rowsMap), scanMs: Date.now() - t0 };
}

export function createAntigravityAdapter() {
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastScanMs = 0, lastScanOk = 0;
  const gate = staleGate(60_000, SNAPSHOT_MAX_AGE, fetchQuotaFromLS);
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'antigravity',
    name: 'Antigravity',
    color: '#fb7185',
    warm() {
      gate({}).catch(() => {});
      rowsCache.warm();
    },
    async quota() {
      try {
        const t0 = Date.now();
        const r = await gate({});
        lastLatency = Date.now() - t0;
        const base = { kind: 'windows', windows: r.data.windows, source: r.data.source };
        if (r.stale) {
          const h = Math.round(r.ageMs / 3600000);
          return { ...base, status: 'dormant', note: `agy 未运行 · 数据为 ${h < 1 ? '1 小时内' : h + ' 小时前'}采集` };
        }
        lastOk = Date.now();
        return { ...base, status: 'online' };
      } catch {
        // agy 没在跑是常态，不算异常
        return { status: 'dormant', kind: 'windows', windows: [], note: 'agy 运行时自动采集' };
      }
    },
    async usageRows() {
      const t0 = Date.now();
      const r = await rowsCache.get();
      lastScanMs = Date.now() - t0;
      lastScanOk = Date.now();
      return r.rows;
    },
    // 跟随最近一次 quota / scan 实况
    health() {
      const op = lastOk || lastScanOk;
      return { state: op ? 'operational' : 'dormant', latencyMs: Math.round(lastLatency || lastScanMs) };
    },
  };
}
