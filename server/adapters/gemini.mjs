// adapters/gemini.mjs — Gemini API 渠道（按 API key 计费的 Gemini 调用；无配额窗口）
// 和 Antigravity 渠道的分界：Antigravity（IDE/CLI）只能用 Google 账号登录、消耗订阅额度；
//   这里只统计「按 token 付费」的 Gemini API 调用。Google I/O 2026 后 Gemini CLI 的 Google
//   账号登录已停服，仍在用 Gemini CLI 的只剩付费 API key / 企业用户，所以两个渠道不重叠。
// 为什么扫本地：Gemini API 没有用量查询端点（只有 AI Studio 网页 Dashboard），
//   只能读调用方客户端留在本地的会话记录。直接用 SDK 写脚本调 API 的用量无从采集。
//
// 数据源一：Gemini CLI（格式依据 google-gemini/gemini-cli 源码 chatRecordingService.ts）
//   <runtime>/tmp/<项目短名>/chats/**/*.jsonl（旧版 *.json 整文件）。runtime = $GEMINI_CLI_HOME
//   或 ~ 下的 .gemini；macOS seatbelt 沙箱下是 ~/.cache/.gemini。
//   - 追加式 JSONL：同一条消息更新时会整条重写一行（同 id），按 id 去重、后写覆盖。
//   - `$rewindTo` 回退记录不处理：被回退的调用 token 已真实花掉，照样计入。
//   - tokens 直接来自 API usageMetadata：input=promptTokenCount **含** cached；
//     thoughts / tool 独立于 input/output。→ 新鲜输入 = input + tool − cached，输出 = output + thoughts。
//   - 项目路径：<runtime>/projects.json 的 { projects: { 绝对路径: 短名 } } 反查。
// 数据源二：OpenCode（依据 anomalyco/opencode 源码 session.ts getUsage / sql.ts）
//   ~/.local/share/opencode/opencode*.db（$XDG_DATA_HOME 优先）的 message 表，
//   只取 providerID 为 google / google-vertex 的 assistant 消息（走 OpenRouter 的已在 OpenRouter 渠道）。
//   - OpenCode 存的 tokens 已归一化：input **不含** cache，output **不含** reasoning → 各项直接相加。
//     与 Gemini CLI 口径相反，不能共用换算。
//   - 旧版 storage/message/*.json 不读（升级时已迁入 SQLite，同时读会重复计数）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { swr } from '../ttl.mjs';
import { readNewLines, localDate } from '../scan-util.mjs';

const HOME = os.homedir();
const CACHE_FILE = fileURLToPath(new URL('../.cache/gemini-scan.json', import.meta.url));
const SCAN_DAYS = 95; // 覆盖热力图 84 天 + 余量
const OC_PROVIDERS = ['google', 'google-vertex'];

function geminiRuntimeDirs() {
  const base = process.env.GEMINI_CLI_HOME || HOME;
  return [...new Set([path.join(base, '.gemini'), path.join(HOME, '.cache', '.gemini')])];
}

function opencodeDbFiles() {
  const dir = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^opencode(-[\w.-]+)?\.db$/.test(n)).map((n) => path.join(dir, n));
}

// ---------- Gemini CLI ----------

function listChatFiles() {
  const out = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  for (const runtime of geminiRuntimeDirs()) {
    const tmp = path.join(runtime, 'tmp');
    let slugToPath = {};
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(runtime, 'projects.json'), 'utf8'));
      for (const [p, slug] of Object.entries(reg.projects || {})) slugToPath[slug] = p;
    } catch {}
    let projects = [];
    try { projects = fs.readdirSync(tmp); } catch { continue; }
    for (const proj of projects) {
      const cwd = slugToPath[proj] || null; // 旧版 hash 目录名反查不到，项目面板里不出现
      // chats/ 下直接放会话文件；子 agent 会话在 chats/<父会话id>/ 下多一层
      const walk = (dir, depth) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 1) walk(p, depth + 1); continue; }
          if (!/\.jsonl?$/.test(e.name)) continue;
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs >= cutoff) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, cwd });
          } catch {}
        }
      };
      walk(path.join(tmp, proj, 'chats'), 0);
    }
  }
  return out;
}

// 一条 Gemini CLI 消息记录 → 标准化 token 行；非 gemini 回复或无 tokens 返回 null
function cliMsg(j, cwd) {
  if (!j || j.type !== 'gemini' || !j.id || !j.tokens || !j.timestamp) return null;
  const ts = Date.parse(j.timestamp);
  if (isNaN(ts)) return null;
  const t = j.tokens;
  const cached = t.cached || 0;
  return {
    date: localDate(ts), model: j.model || 'gemini', cwd,
    input: Math.max(0, (t.input || 0) + (t.tool || 0) - cached),
    output: (t.output || 0) + (t.thoughts || 0),
    cacheRead: cached,
  };
}

function loadScanCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.v !== 1) throw new Error('version');
    return c;
  } catch { return { v: 1, files: {} }; }
}
function saveScanCache(c) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {}
}

// 返回 { rows, found }：found = 扫到过任何会话文件（区分「没装」与「装了但窗口内没用」）
function scanCli() {
  const cache = loadScanCache();
  const files = listChatFiles();
  const keepAfter = localDate(Date.now() - SCAN_DAYS * 86400000);
  for (const f of files) {
    let rec = cache.files[f.path];
    if (f.path.endsWith('.json')) {
      // 旧版整文件 JSON：变了就整份重解析
      if (rec && rec.size === f.size && rec.mtimeMs === f.mtimeMs) continue;
      rec = cache.files[f.path] = { offset: 0, size: f.size, mtimeMs: f.mtimeMs, msgs: {} };
      try {
        const conv = JSON.parse(fs.readFileSync(f.path, 'utf8'));
        for (const m of conv.messages || []) {
          const r = cliMsg(m, f.cwd);
          if (r) rec.msgs[m.id] = r;
        }
      } catch {}
      continue;
    }
    // JSONL：文件变小 = 被原子重写（resume 旧会话时），整份重扫
    if (!rec || f.size < rec.size) rec = cache.files[f.path] = { offset: 0, size: 0, msgs: {} };
    if (rec.offset >= f.size) continue;
    rec.offset = readNewLines(f.path, rec.offset, (line) => {
      if (!line.includes('"tokens"')) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const r = cliMsg(j, f.cwd);
      if (r) rec.msgs[j.id] = r; // 同 id 后写覆盖（tokens 可能在第二次写入时才补上）
    });
    rec.size = f.size;
  }
  const live = new Set(files.map((f) => f.path));
  for (const p of Object.keys(cache.files)) if (!live.has(p)) delete cache.files[p];
  saveScanCache(cache);
  const rows = [];
  for (const rec of Object.values(cache.files)) {
    for (const r of Object.values(rec.msgs)) if (r.date >= keepAfter) rows.push(r);
  }
  return { rows, found: files.length > 0 };
}

// ---------- OpenCode ----------

function opencodeSql(cutoffMs) {
  const prov = OC_PROVIDERS.map((p) => `'${p}'`).join(',');
  return `SELECT json_extract(m.data,'$.modelID') AS model, json_extract(m.data,'$.time.created') AS ts,
    json_extract(m.data,'$.tokens.input') AS i, json_extract(m.data,'$.tokens.output') AS o,
    json_extract(m.data,'$.tokens.reasoning') AS r, json_extract(m.data,'$.tokens.cache.read') AS cr,
    json_extract(m.data,'$.tokens.cache.write') AS cw, s.directory AS dir
    FROM message m LEFT JOIN session s ON s.id = m.session_id
    WHERE json_extract(m.data,'$.role') = 'assistant'
      AND json_extract(m.data,'$.providerID') IN (${prov})
      AND json_extract(m.data,'$.time.created') >= ${Math.floor(cutoffMs)}`;
}

async function queryDb(dbPath, sql) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch {}
  try {
    const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : [];
  } catch {}
  return null; // 读失败（表结构不符/被锁）
}

async function scanOpencode() {
  const rows = [];
  const cutoff = Date.now() - SCAN_DAYS * 86400000;
  for (const db of opencodeDbFiles()) {
    const res = await queryDb(db, opencodeSql(cutoff));
    for (const x of res || []) {
      if (typeof x.ts !== 'number') continue;
      rows.push({
        date: localDate(x.ts), model: x.model || 'gemini', cwd: x.dir || null,
        input: x.i || 0, output: (x.o || 0) + (x.r || 0), cacheRead: x.cr || 0, cacheWrite: x.cw || 0,
      });
    }
  }
  return rows;
}

// ---------- 聚合 ----------

async function scan() {
  const cli = scanCli();
  const oc = await scanOpencode();
  const agg = new Map();
  for (const r of [...cli.rows, ...oc]) {
    const key = `${r.date}|${r.model}|${r.cwd || ''}`;
    const a = agg.get(key) || (agg.set(key, { date: r.date, model: r.model, cwd: r.cwd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, req: 0 }), agg.get(key));
    a.input += r.input; a.output += r.output;
    a.cacheRead += r.cacheRead || 0; a.cacheWrite += r.cacheWrite || 0;
    a.req += 1;
  }
  return { rows: [...agg.values()], found: cli.found || oc.length > 0 };
}

export function createGeminiAdapter() {
  let lastFound = false;
  const cache = swr(5 * 60_000, async () => { const r = await scan(); lastFound = r.found; return r; });

  return {
    id: 'gemini', name: 'Gemini API', color: '#ffc800',
    warm() { cache.warm(); },
    async quota() {
      const { rows, found } = await cache.get();
      // ~/.gemini 目录本身不能当依据：Antigravity 也会建它。必须真扫到会话记录才算配置
      if (!found) {
        return { status: 'unconfigured', kind: 'usage', note: '未检测到 Gemini CLI / OpenCode（Google）使用记录' };
      }
      const today = localDate(Date.now());
      const t = { requests: 0, tokens: 0 };
      for (const r of rows) {
        if (r.date !== today) continue;
        t.requests += r.req;
        t.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      }
      return { status: 'online', kind: 'usage', today: t, note: '无官方用量接口 · 读本地会话记录' };
    },
    async usageRows() { return (await cache.get()).rows; },
    health() {
      // health 是同步的：用上次扫描结果，首次扫描前按未配置处理
      if (!lastFound) return { state: 'unconfigured', latencyMs: 0 };
      return { state: 'operational', latencyMs: 0 };
    },
  };
}
