// adapters/cursor.mjs — Cursor 渠道（仅配额，无 token 序列）
// 凭证：~/Library/Application Support/Cursor/User/globalStorage/state.vscdb（sqlite，WAL）。
//   读时先复制 db+wal+shm 到临时目录再开（最稳），node:sqlite 优先，失败回退 sqlite3 CLI。
// 配额：POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage（Connect 协议）。
//   月账期花费制 → 映射「月账期」窗口（totalPercentUsed，billingCycleEnd 做 reset）。
// accessToken 无刷新流程：401 → offline + 副标「凭证过期，重新打开 Cursor 登录」；
//   其他失败走 stale（≤30min 旧快照）。
// 安全红线：token 只进内存。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { staleGate } from '../ttl.mjs';

const VSCDB = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

async function readCursorAuth() {
  const tmp = path.join(os.tmpdir(), `aub-cursor-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.copyFileSync(VSCDB + suffix, path.join(tmp, 'state.vscdb' + suffix)); } catch {}
    }
    const dbPath = path.join(tmp, 'state.vscdb');
    const keys = ['cursorAuth/accessToken', 'cursorAuth/stripeMembershipType', 'cursorAuth/cachedEmail'];
    const out = {};
    try {
      // node:sqlite 需 Node ≥22.5（22.x 还要 flag），双击场景可能落到 /usr/local/bin/node v22 → 动态 import 兜底
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      for (const k of keys) out[k] = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(k)?.value || null;
      db.close();
    } catch {
      for (const k of keys) {
        try {
          out[k] = execFileSync('/usr/bin/sqlite3', [dbPath, `SELECT value FROM ItemTable WHERE key='${k}';`], { encoding: 'utf8', timeout: 5000 }).trim() || null;
        } catch { out[k] = null; }
      }
    }
    return out;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

class AuthExpired extends Error {}

async function fetchUsage() {
  const auth = await readCursorAuth();
  const token = auth['cursorAuth/accessToken'];
  if (!token) throw new Error('no cursor credentials');
  const res = await fetch(USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: '{}',
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpired(`cursor usage HTTP ${res.status}`);
  if (!res.ok) throw new Error(`cursor usage HTTP ${res.status}`);
  const j = await res.json();
  const pu = j.planUsage || {};
  const now = Date.now();
  const start = Number(j.billingCycleStart), end = Number(j.billingCycleEnd);
  const resetInSec = isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : null;
  const windowSec = isFinite(start) && isFinite(end) ? Math.round((end - start) / 1000) : 30 * 86400;
  const membership = auth['cursorAuth/stripeMembershipType'];
  const split = pu.autoPercentUsed !== pu.apiPercentUsed
    ? `auto ${pu.autoPercentUsed}% / api ${pu.apiPercentUsed}%` : null;
  return {
    windows: [{
      label: '月账期', windowSec,
      usedPct: Math.round((Number(pu.totalPercentUsed) || 0) * 10) / 10,
      timePct: isFinite(start) && isFinite(end) ? Math.min(100, Math.round(((now - start) / (end - start)) * 100)) : null,
      resetInSec,
    }],
    source: 'direct',
    note: [membership ? membership[0].toUpperCase() + membership.slice(1) + ' 订阅' : null, split].filter(Boolean).join(' · ') || undefined,
  };
}

export function createCursorAdapter() {
  const gate = staleGate(60_000, 30 * 60_000, fetchUsage);
  let lastOk = 0, lastLatency = 0;

  return {
    id: 'cursor', name: 'Cursor', color: '#818cf8', tokenData: false, // 无 token 序列（本地无干净日志）
    warm() { gate({}).catch(() => {}); },
    async quota() {
      const t0 = Date.now();
      try {
        const r = await gate({});
        lastLatency = Date.now() - t0; lastOk = Date.now();
        const base = { kind: 'windows', windows: r.data.windows, source: r.data.source, note: r.data.note };
        if (r.stale) {
          const mins = Math.max(1, Math.round(r.ageMs / 60000));
          return { ...base, status: 'stale', note: `数据为 ${mins} 分钟前 · 查询失败重试中` };
        }
        return { ...base, status: 'online' };
      } catch (e) {
        if (e instanceof AuthExpired) {
          return { status: 'offline', kind: 'windows', windows: [], note: '凭证过期，重新打开 Cursor 登录' };
        }
        throw e;
      }
    },
    async usageRows() { return []; },
    health() {
      return { state: lastOk ? 'operational' : 'degraded', latencyMs: Math.round(lastLatency) };
    },
  };
}
