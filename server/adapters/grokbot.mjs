// adapters/grokbot.mjs — Grok Bot 渠道（配额 + 本地 Token 序列）
// Grok Bot 是 xAI 的产品，基于 Anysphere 的 Sand 架构运行。
// 配额（双源容错）：
//   1. 优先通过 Cursor 凭证（state.vscdb → cursorAuth/accessToken）调用 api2.cursor.sh。
//   2. 仅在网络错误、凭证缺失或 401/403 时回退读取桌面客户端本地切片（weekly-usage.cache，Base32 编码）；
//      远端明确返回 NotIncluded（套餐不含）或 Unreadable 时直接抛出，不吞掉结论。
//   3. 本地缓存带有 readAtMs 与 expiresAtMs，过期时返回 stale 态并提示离线。
// Token 序列（会话文本估算）：
//   扫描 sand-client-persistence/ 下的 transcript.replicas.* 会话切片。
//   按 role 分类（user 为输入，assistant 为输出），基于 entry id 和 requestId 双重去重。
//   真增量持久化累加至 server/.cache/grokbot-scan.json，防止滚动窗口截断导致旧日期用量缩水。
//   在 Coding Agent 面板标明「会话文本估算（仅本地可见部分）」，暂不进费用估值与订阅回报。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { swr, staleGate } from '../ttl.mjs';
import { localDate } from '../scan-util.mjs';
import { readCursorAuth } from './cursor.mjs';
import { readCacheJson, writeCacheJson } from '../cache-util.mjs';

const HOME = os.homedir();
const SAND_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const WEEK_SEC = 7 * 86400;
const GROKBOT_DIR = path.join(HOME, 'Library', 'Application Support', 'Grok Bot');
const GROKBOT_DATA_DIR = path.join(GROKBOT_DIR, 'sand-client-persistence');
const VSCDB = path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const CACHE_FILE = fileURLToPath(new URL('../.cache/grokbot-scan.json', import.meta.url));
const SCAN_DAYS = Number(process.env.AUB_SCAN_DAYS) || 95;

class AuthExpired extends Error {}
class NotIncluded extends Error {}
class Unreadable extends Error {}

const pick = (o, camel) => o[camel] ?? o[camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())];

function parseTs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

// RFC 4648 Base32 解码（用于还原 sand-client-persistence 中的切片 key）
function base32Decode(s) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0;
  const output = [];
  for (let i = 0; i < s.length; i++) {
    const idx = alphabet.indexOf(s[i].toLowerCase());
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output).toString('utf8');
}

// 导出供测试直接驱动
export function windowFromReply(j, now = Date.now()) {
  const pooled = pick(j, 'usesPooledEnterpriseAllowance');
  const zero = pick(j, 'includedLimitZero');
  const nonZero = pick(j, 'hasNonZeroIncludedLimit');
  const pct = pick(j, 'usagePercent');
  if (pooled == null && zero == null && nonZero == null) throw new Unreadable('grok bot reply has no allowance flags');
  if (pooled === true) throw new NotIncluded('组织共享额度，无个人份额');
  if (zero === true || nonZero !== true) throw new NotIncluded('当前套餐不含 Grok Bot');
  const used = Number(pct);
  if (pct == null || !Number.isFinite(used)) throw new Unreadable('grok bot reply has no usagePercent');

  // 显示口径对齐官方客户端：已用>0 且不足 1% 显示 1%，否则四舍五入到整数。
  const clamped = Math.min(100, Math.max(0, used));
  const shown = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
  const exact = clamped > 0 && clamped < 1 ? `实际 ${Number(clamped.toPrecision(2))}%` : (clamped % 1 !== 0 ? `实际 ${Math.round(clamped * 10) / 10}%` : null);

  const reset = parseTs(pick(j, 'nextResetTimestampUtc'));
  const start = parseTs(pick(j, 'currentPeriodStart'));
  return {
    windows: [{
      label: '周额度', windowSec: WEEK_SEC,
      usedPct: shown,
      timePct: start && reset && reset > start ? Math.min(100, Math.round(((now - start) / (reset - start)) * 100)) : null,
      resetInSec: reset ? Math.max(0, Math.round((reset - now) / 1000)) : null,
    }],
    source: j.__source || 'direct',
    note: [pick(j, 'grokPlanLabel')?.trim(), exact].filter(Boolean).join(' · ') || undefined,
  };
}

// 本地客户端持久化缓存回退（无需 Cursor 凭证）
function readLocalWeeklyUsage(now = Date.now()) {
  if (!fs.existsSync(GROKBOT_DATA_DIR)) return null;
  let files = [];
  try {
    files = fs.readdirSync(GROKBOT_DATA_DIR).filter((f) => f.endsWith('.blob'));
  } catch { return null; }

  for (const f of files) {
    try {
      const decoded = base32Decode(f.slice(0, -5));
      if (decoded.includes('weekly-usage.cache')) {
        const raw = fs.readFileSync(path.join(GROKBOT_DATA_DIR, f), 'utf8');
        const j = JSON.parse(raw);
        const val = j.value;
        const usage = val?.reading?.usage;
        if (usage && usage.percentUsed != null) {
          const reset = usage.nextResetMs;
          const resetInSec = reset && reset > now ? Math.max(0, Math.round((reset - now) / 1000)) : null;
          const readAtMs = val?.reading?.readAtMs;
          const expiresAtMs = val?.expiresAtMs;
          const isExpired = expiresAtMs ? now > expiresAtMs : (readAtMs ? now - readAtMs > 24 * 3600000 : false);

          const res = windowFromReply({
            usesPooledEnterpriseAllowance: false,
            includedLimitZero: false,
            hasNonZeroIncludedLimit: usage.hasNonZeroIncludedLimit ?? true,
            usagePercent: usage.percentUsed,
            nextResetTimestampUtc: usage.nextResetMs,
            grokPlanLabel: usage.grokPlanLabel || 'SuperGrok',
            __source: 'local-cache',
          }, now);

          if (res.windows?.[0] && resetInSec != null) {
            res.windows[0].timePct = Math.min(100, Math.max(0, Math.round((1 - resetInSec / WEEK_SEC) * 100)));
          }

          if (isExpired) {
            const hours = readAtMs ? Math.max(1, Math.round((now - readAtMs) / 3600000)) : null;
            return {
              ...res,
              isStale: true,
              staleNote: [usage.grokPlanLabel || 'SuperGrok', hours ? `数据为 ${hours} 小时前 · 客户端离线` : '本地缓存已过期 · 客户端离线'].filter(Boolean).join(' · '),
            };
          }
          return res;
        }
      }
    } catch {}
  }
  return null;
}

async function fetchUsage() {
  let canFallback = false;
  let remoteErr = null;

  if (fs.existsSync(VSCDB)) {
    try {
      const auth = await readCursorAuth();
      const token = auth['cursorAuth/accessToken'];
      if (token) {
        const res = await fetch(SAND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          },
          body: '{}',
          signal: AbortSignal.timeout(12_000),
        });
        if (res.status === 401 || res.status === 403) {
          canFallback = true;
          remoteErr = new AuthExpired(`grok bot usage HTTP ${res.status}`);
        } else if (!res.ok) {
          canFallback = true;
          remoteErr = new Error(`grok bot usage HTTP ${res.status}`);
        } else {
          return windowFromReply(await res.json());
        }
      } else {
        canFallback = true;
        remoteErr = new AuthExpired('no cursor token');
      }
    } catch (e) {
      if (e instanceof NotIncluded || e instanceof Unreadable) {
        throw e; // 明确结论直接抛出，不被 catch 吞掉去读本地缓存
      }
      canFallback = true;
      remoteErr = e;
    }
  } else {
    canFallback = true;
    remoteErr = new AuthExpired('no cursor credentials');
  }

  // 仅在网络错误、凭证缺失或 401/403 时回退读取 Grok Bot 本地切片缓存
  if (canFallback) {
    const local = readLocalWeeklyUsage();
    if (local) return local;
  }

  if (remoteErr) throw remoteErr;
  throw new AuthExpired('no grokbot credentials');
}

// 混合文本 Tokenizer 估算（中文 ~1.5 字符/tok，代码英文 ~4 字符/tok）
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x2e80) cjk++;
    else ascii++;
  }
  return Math.max(1, Math.round(cjk / 1.5 + ascii / 4));
}

function loadCache() {
  try {
    const c = readCacheJson(CACHE_FILE);
    if (c.v === 2 && c.files && c.daily && c.seenIds) return c;
  } catch {}
  return { v: 2, files: {}, seenIds: {}, seenReqs: {}, daily: {} };
}

function saveCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeCacheJson(CACHE_FILE, c);
  } catch {}
}

function buildRows(daily) {
  const cutoffMs = Date.now() - SCAN_DAYS * 86400000;
  const keepAfter = localDate(cutoffMs);
  const rows = [];
  for (const [date, val] of Object.entries(daily || {})) {
    if (date < keepAfter) continue;
    if (val.input === 0 && val.output === 0) continue;
    rows.push({
      date, model: 'grok-bot', cwd: null, input: val.input, output: val.output, cacheRead: 0, cacheWrite: 0,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// Token 序列增量扫描：读取 sand-client-persistence/ 目录下所有会话 transcript replicas
function scan() {
  const cache = loadCache();
  if (!fs.existsSync(GROKBOT_DATA_DIR)) {
    return buildRows(cache.daily);
  }

  let blobFiles = [];
  try {
    blobFiles = fs.readdirSync(GROKBOT_DATA_DIR).filter((f) => f.endsWith('.blob'));
  } catch {
    return buildRows(cache.daily);
  }

  const cutoffMs = Date.now() - SCAN_DAYS * 86400000;
  const keepAfter = localDate(cutoffMs);
  let changed = false;

  for (const f of blobFiles) {
    const decoded = base32Decode(f.slice(0, -5));
    if (!decoded.includes('transcript.replicas')) continue;

    const fullPath = path.join(GROKBOT_DATA_DIR, f);
    let st;
    try { st = fs.statSync(fullPath); } catch { continue; }
    if (st.mtimeMs < cutoffMs) continue;

    const rec = cache.files[fullPath];
    if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) {
      continue; // 未变动直接复用
    }

    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const j = JSON.parse(raw);
      const entries = j.value?.entries || [];

      for (const e of entries) {
        if (!e.timestampMs || !e.id) continue;
        if (cache.seenIds[e.id]) continue;
        cache.seenIds[e.id] = 1;
        changed = true;

        const date = localDate(e.timestampMs);
        if (date < keepAfter) continue;

        const d = cache.daily[date] || (cache.daily[date] = { input: 0, output: 0 });

        if (e.kind === 'message') {
          const text = e.content || e.message?.content || e.richText || '';
          const tok = estimateTokens(text);
          if (e.role === 'user') {
            if (e.requestId && cache.seenReqs[e.requestId]) continue;
            if (e.requestId) cache.seenReqs[e.requestId] = 1;
            d.input += tok;
          } else if (e.role === 'assistant') {
            d.output += tok;
          }
        } else if (e.kind === 'send-message') {
          if (e.requestId && cache.seenReqs[e.requestId]) continue;
          if (e.requestId) cache.seenReqs[e.requestId] = 1;
          const text = e.message?.content || e.content || e.richText || '';
          const tok = estimateTokens(text);
          d.input += tok;
        }
      }

      cache.files[fullPath] = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {}
  }

  if (changed) {
    saveCache(cache);
  }

  return buildRows(cache.daily);
}

export function createGrokBotAdapter() {
  const gate = staleGate(60_000, 30 * 60_000, fetchUsage);
  const rowsCache = swr(5 * 60_000, async () => scan());
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'grokbot', name: 'Grok Bot', color: '#fb7185',
    tokenTag: '会话文本估算（仅本地可见部分）',
    costData: false, // 助手回复不全量落盘，不进费用估值与订阅回报，避免误导
    warm() { gate({}).catch(() => {}); rowsCache.warm(); },
    async quota() {
      const hasLocal = fs.existsSync(GROKBOT_DATA_DIR);
      const hasCursor = fs.existsSync(VSCDB);
      if (!hasLocal && !hasCursor) {
        return { status: 'unconfigured', kind: 'windows', windows: [], note: '未检测到 Grok Bot 使用记录' };
      }

      const t0 = Date.now();
      try {
        const r = await gate({});
        lastLatency = Date.now() - t0; lastOk = Date.now();
        const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
        if (r.data.isStale) {
          return { ...base, status: 'stale', note: r.data.staleNote || base.note };
        }
        if (r.stale) {
          const mins = Math.max(1, Math.round(r.ageMs / 60000));
          return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
        }
        return { ...base, status: 'online' };
      } catch (e) {
        if (e instanceof AuthExpired) {
          return { status: 'offline', kind: 'windows', windows: [], note: '未登录 Grok Bot 或凭证已过期' };
        }
        if (e instanceof NotIncluded) {
          return { status: 'offline', kind: 'windows', windows: [], note: e.message };
        }
        if (e instanceof Unreadable) {
          return { status: 'offline', kind: 'windows', windows: [], note: '接口回包读不懂（可能已改版）' };
        }
        throw e;
      }
    },
    async usageRows() { return rowsCache.get(); },
    health() {
      const hasLocal = fs.existsSync(GROKBOT_DATA_DIR);
      const hasCursor = fs.existsSync(VSCDB);
      if (!hasLocal && !hasCursor) return { state: 'unconfigured', latencyMs: 0 };
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
