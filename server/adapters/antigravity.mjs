// adapters/antigravity.mjs — Antigravity（agy）渠道：配额 + 本地 Token 序列
// 配额：agy 运行时起本地 language server——从最新 cli-*.log 正则端口，POST RetrieveUserQuotaSummary。
//       agy 不在跑 → dormant（灰 pill「未运行」，不进告警横幅）。
// Token 序列：扫描 CLI（~/.gemini/antigravity-cli）与桌面客户端（~/.gemini/antigravity）两处
//             conversations/*.db 的 gen_metadata 表（protobuf 编码），结合各自的
//             brain/<cid>/.system_generated/logs/transcript.jsonl，
//             提取各 turn 的 input / output / cacheRead token 及模型名称。
//             增量缓存至 server/.cache/antigravity-scan.json。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { swr, staleGate } from '../ttl.mjs';
import { localDate } from '../scan-util.mjs';
import { readCacheJson, writeCacheJson } from '../cache-util.mjs';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'log');
const SESSION_ROOTS = ['antigravity-cli', 'antigravity'].map((d) => path.join(HOME, '.gemini', d));
const CACHE_FILE = fileURLToPath(new URL('../.cache/antigravity-scan.json', import.meta.url));
const SNAPSHOT_MAX_AGE = 24 * 3600_000;
const SCAN_DAYS = Number(process.env.AUB_SCAN_DAYS) || 110;

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

// 单步 Token 物理合理性上限：Gemini 上下文窗口最多 2M，单 turn 设 5M 足够留出安全裕度，
// 同时可绝对防御误读子消息中的纳秒/秒级时间戳、整数 ID 等大数值（如 1786700152）。
const MAX_TOKENS_PER_STEP = 5_000_000;

function extractUsage(chunk) {
  let pos = 0, input = 0, output = 0, cacheRead = 0, found = false;
  while (pos < chunk.length) {
    const [key, np] = parseVarint(chunk, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) {
      const [val, n] = parseVarint(chunk, pos); pos = n;
      if (val > MAX_TOKENS_PER_STEP) return null; // 防御异常大数
      if (fnum === 1) { input = val; found = true; }
      else if (fnum === 3) { output = val; found = true; }
      else if (fnum === 5) { cacheRead = val; found = true; }
    } else if (wire === 2) {
      const [len, n] = parseVarint(chunk, pos); pos = n;
      pos += len;
    } else break;
  }
  if (!found || (input + output + cacheRead === 0)) return null;
  if (input > MAX_TOKENS_PER_STEP || output > MAX_TOKENS_PER_STEP || cacheRead > MAX_TOKENS_PER_STEP) {
    return null;
  }
  return { input, output, cacheRead };
}

// 严格对齐 Google Gemini 原生 Protobuf 规范：
// 顶层 field 1: GenerateContentResponse
// GenerateContentResponse.usage_metadata 严格为 field 4
// UsageMetadata:
//   field 1: prompt_token_count (input)
//   field 3: candidates_token_count (output)
//   field 5: cached_content_token_count (cacheRead)
// 严禁对其他子消息盲猜字段号；非模型生成事件（如工具调用、元事件）没有 field 4，直接返 null。
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

  pos = 0;
  while (pos < f1.length) {
    const [key, np] = parseVarint(f1, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) { const [, n] = parseVarint(f1, pos); pos = n; }
    else if (wire === 2) {
      const [len, n] = parseVarint(f1, pos); pos = n;
      const val = f1.subarray(pos, pos + len); pos += len;
      if (fnum === 4) {
        return extractUsage(val);
      }
    } else break;
  }

  return null;
}

// gen_metadata.idx 是「第几次生成」，transcript 的 step_index 是「第几步」，两套编号不对应。
// 每条记录的顶层 field 2 是本次生成产出的步骤号列表（packed varint），取第一个去查时间。
function firstStepIndex(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const [key, np] = parseVarint(buf, pos); pos = np;
    const fnum = key >> 3, wire = key & 7;
    if (wire === 0) { const [, n] = parseVarint(buf, pos); pos = n; }
    else if (wire === 2) {
      const [len, n] = parseVarint(buf, pos); pos = n;
      if (fnum === 2 && len > 0) return parseVarint(buf, pos)[0];
      pos += len;
    } else break;
  }
  return null;
}

// 该步骤没有时间时往前找最近的一步。别轻易退回到文件修改时间：会话续聊后它会变，
// 同一条记录换了日期，只增不减的历史归档就会两边各记一份。
function stepDate(stepDates, step) {
  for (let i = step; i != null && i >= 0; i--) {
    const d = stepDates.get(i);
    if (d) return d;
  }
  return null;
}

async function readDbEntries(dbPath) {
  const entries = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
    for (const r of rows) {
      entries.push({ idx: r.idx, data: Buffer.from(r.data) });
    }
    db.close();
    return entries;
  } catch {}

  try {
    const out = execFileSync('/usr/bin/sqlite3', [dbPath, 'SELECT idx, quote(data) FROM gen_metadata ORDER BY idx;'], {
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

function readTranscriptInfo(brainDir, cid) {
  const tfile = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
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
    const c = readCacheJson(CACHE_FILE);
    if (c.v === 2 && c.files && c.rows) return c;
    if (c.v === 1 && c.files) {
      // 从旧版升级：v1 的日期归属有错，缓存作废重扫。每个会话的旧行先留在 legacy 里，
      // 重扫成功后用它从历史归档里扣掉旧值（见 scan 里的 rekey）
      const legacy = {};
      for (const [p, f] of Object.entries(c.files)) if (f.rows?.length) legacy[p] = f.rows;
      return { v: 2, files: {}, rows: {}, legacy, upgrading: true };
    }
  } catch {}
  return { v: 2, files: {}, rows: {} };
}

function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeCacheJson(CACHE_FILE, c);
  } catch {}
}

const sumTokens = (rows) => rows.reduce((s, r) => s + r.input + r.output + r.cacheRead, 0);

async function scan(archive) {
  const t0 = Date.now();
  const files = [];
  for (const root of SESSION_ROOTS) {
    try {
      for (const f of fs.readdirSync(path.join(root, 'conversations'))) {
        if (f.endsWith('.db')) files.push({ root, f });
      }
    } catch {} // 只装了其中一端时另一个目录不存在
  }
  if (!files.length) return { rows: [], scanMs: 0 };

  const cutoffMs = Date.now() - SCAN_DAYS * 86400000;
  const keepAfter = localDate(cutoffMs);
  const cache = loadCache();
  const activePaths = new Set();
  const rowsMap = {};
  const addRows = (list) => {
    for (const r of list) {
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
  };
  const moves = []; // 升级时要在历史归档里换键的会话

  for (const { root, f } of files) {
    const dbPath = path.join(root, 'conversations', f);
    activePaths.add(dbPath);
    let st;
    try { st = fs.statSync(dbPath); } catch { continue; }
    // 进行中的会话先写 -wal，主库的 mtime/size 要到 checkpoint 才变
    let wal = null;
    try { wal = fs.statSync(`${dbPath}-wal`); } catch {}
    const mtimeMs = wal && wal.size ? Math.max(st.mtimeMs, wal.mtimeMs) : st.mtimeMs;
    const walSize = wal ? wal.size : 0;
    if (mtimeMs < cutoffMs) continue;

    const cachedFile = cache.files[dbPath];
    if (cachedFile && cachedFile.mtimeMs === mtimeMs && cachedFile.size === st.size && cachedFile.walSize === walSize && cachedFile.rows) {
      addRows(cachedFile.rows);
      continue;
    }

    const cid = f.replace(/\.db$/, '');
    const fallbackDate = localDate(mtimeMs);
    const { stepDates, cwd } = readTranscriptInfo(path.join(root, 'brain'), cid);
    const entries = await readDbEntries(dbPath);
    const fileRows = []; // 这里不按扫描窗口过滤：换键时要整个会话的新行
    let lastStep = null;

    for (const e of entries) {
      const tok = parseTokensFromProto(e.data);
      // 过滤非生成事件及无 token 消耗的空记录（避免统计空转与假默认值污染）
      if (!tok || (tok.input + tok.output + tok.cacheRead === 0)) continue;
      const step = firstStepIndex(e.data);
      if (step != null) lastStep = step; // 个别记录不带步骤号，沿用上一条的
      const date = stepDate(stepDates, lastStep) || fallbackDate; // 日志里查不到时才用文件时间

      const m = e.data.toString('latin1').match(/(gemini-[\w\.\-]+|claude-[\w\.\-]+|gpt-[\w\.\-]+|chatgpt-[\w\.\-]+|o1-[\w\.\-]+|o3-[\w\.\-]+)/i);
      const model = m ? m[1].toLowerCase() : 'gemini';
      const freshInput = Math.max(0, tok.input - tok.cacheRead); // prompt_token_count 官方文档写明已含 cached_content_token_count，需要减掉避免重复计费
      fileRows.push({
        date, model, cwd: cwd || null, input: freshInput, output: tok.output, cacheRead: tok.cacheRead,
      });
    }

    const old = cache.legacy?.[dbPath];
    if (archive && old) {
      // 会话只增不减。读出来比旧值还少，多半是这次没读全：不计数、不缓存，归档保持原样，下轮再试
      if (sumTokens(fileRows) < sumTokens(old)) continue;
      moves.push({ dbPath, id: `step-dates:${path.basename(root)}/${cid}`, remove: old, add: fileRows });
    } else if (archive && cache.upgrading) {
      moves.push({ dbPath, id: `step-dates:${path.basename(root)}/${cid}`, remove: [], add: fileRows });
    }

    addRows(fileRows);
    cache.files[dbPath] = { mtimeMs, size: st.size, walSize, rows: fileRows };
  }

  if (moves.length) {
    const saved = archive.rekey('antigravity', moves);
    for (const m of moves) {
      if (saved) delete cache.legacy?.[m.dbPath];
      else delete cache.files[m.dbPath]; // 归档没写进磁盘：下轮重读这个会话，再确认一次
    }
  }
  delete cache.upgrading;

  // 清理不存在的旧缓存
  for (const p of Object.keys(cache.files)) {
    if (!activePaths.has(p)) delete cache.files[p];
  }
  cache.rows = rowsMap;
  saveCache(cache);

  return { rows: Object.values(rowsMap), scanMs: Date.now() - t0 };
}

export function createAntigravityAdapter({ archive } = {}) {
  const rowsCache = swr(5 * 60_000, async () => scan(archive));
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
