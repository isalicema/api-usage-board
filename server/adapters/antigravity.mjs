// adapters/antigravity.mjs — Antigravity（agy）渠道：机会主义采集，仅配额
// 凭证位置未定位（旧路径已失效），云端接口走不通。唯一可用路径：agy 运行时会起本地
// language server——从最新 cli-*.log 正则端口，POST RetrieveUserQuotaSummary（500ms 超时，
// 多端口逐个试）。agy 不在跑 → dormant（灰 pill「未运行」，不进告警横幅）。
// 有 ≤24h 旧快照时显示旧数据并注明采集时间。token 永不进日志/响应。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { staleGate } from '../ttl.mjs';

const LOG_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
const SNAPSHOT_MAX_AGE = 24 * 3600_000;

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
        for (const b of g.buckets || []) {
          const weekly = b.window === 'weekly';
          const windowSec = weekly ? 7 * 86400 : 5 * 3600;
          const resetInSec = b.resetTime ? Math.max(0, Math.round((Date.parse(b.resetTime) - now) / 1000)) : null;
          const remaining = Number(b.remainingFraction);
          windows.push({
            label: weekly ? '7天' : '5小时',
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

export function createAntigravityAdapter() {
  const gate = staleGate(60_000, SNAPSHOT_MAX_AGE, fetchQuotaFromLS);

  return {
    id: 'antigravity', name: 'Antigravity', color: '#fb7185', tokenData: false,
    warm() { gate({}).catch(() => {}); },
    async quota() {
      try {
        const r = await gate({});
        const base = { kind: 'windows', windows: r.data.windows, source: r.data.source };
        if (r.stale) {
          const h = Math.round(r.ageMs / 3600000);
          return { ...base, status: 'dormant', note: `agy 未运行 · 数据为 ${h < 1 ? '1 小时内' : h + ' 小时前'}采集` };
        }
        return { ...base, status: 'online' };
      } catch {
        // agy 没在跑是常态，不算异常
        return { status: 'dormant', kind: 'windows', windows: [], note: 'agy 运行时自动采集' };
      }
    },
    async usageRows() { return []; },
    health() { return { state: 'dormant', latencyMs: 0 }; }, // 本地端口探测，延迟无意义
  };
}
