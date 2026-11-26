// history-archive.mjs — 每日用量的永久归档（只增不减）。
// 问题：各渠道的扫描缓存都只保留最近 N 天（95～120 天），更老的日期随滚动窗口一天天掉出累计；
//       缓存一旦被重置（读失败、文件被压缩/归档/清理），历史也跟着丢（实际发生过：Codex 把老会话压成 .zst 后，缓存被重置，数十亿 token 的历史一次性丢失）。
// 做法：渠道每次返回的用量行，都按「日期|模型|目录…」合并进这份归档；输出 = 归档与当前行逐字段取较大值。
//       - 取 max 而不是相加：重复合并幂等，不会重复计数；
//       - 只对「已稳定」的日期生效（早于今天 SETTLE_DAYS 天）：近几天的数据还在涨，以当前扫描为准，不入档；
//       - 当前扫描比归档小（缓存被重置、源文件被压缩/删除、窗口滚动）→ 归档补回，累计不会缩水。
// 例外：渠道修正了行的身份字段（例如日期归错了）时，同一笔用量会换键，只靠 merge 会新旧各留一份——要用 rekey()。
// 代价：取 max 意味着「往下修正」不会生效（例如之前手工扣掉的重复计数）。需要修正时用
//       `node server/tools/archive.mjs drop <渠道> <日期>` 删掉那天的归档，再让渠道重新扫出正确值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheJson, writeCacheJson } from './cache-util.mjs';

export const SETTLE_DAYS = 2;
export const ARCHIVE_FILE = fileURLToPath(new URL('./data/history-archive.json', import.meta.url));
export const CACHE_DIR = fileURLToPath(new URL('./.cache/', import.meta.url));
const NUM = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'cost']); // 数值字段，其余（日期、模型、目录等）是身份
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const rowKey = (r) => JSON.stringify(Object.keys(r).filter((k) => !NUM.has(k)).sort().map((k) => [k, r[k] ?? null]));

export function createArchive({ file = ARCHIVE_FILE, cacheDir = CACHE_DIR, flushMs = 60_000, now = () => Date.now() } = {}) {
  let data = null, dirty = false, timer = null, lastFlush = 0;
  const load = () => {
    if (data) return data;
    let missing = false;
    try { data = readCacheJson(file); } catch (e) { data = null; missing = e.code === 'ENOENT'; }
    if (!data || data.v !== 1 || typeof data.ch !== 'object') data = { v: 1, ch: {} };
    if (missing && cacheDir) seedFromCaches(); // 归档第一次出现：把升级前各渠道缓存里的历史行收进来
    return data;
  };
  // 升级前的缓存（server/.cache/<渠道>-scan.json）里已有的历史行：先收进归档，之后即使缓存被重建/窗口滚动也不会丢。
  // 必须在渠道开始扫描并改写缓存之前同步完成（createArchive 在 server 启动时先于渠道创建）。
  function seedFromCaches() {
    let names = [];
    try { names = fs.readdirSync(cacheDir).filter((n) => /^[a-z]+-scan\.json$/.test(n)); } catch { return; }
    for (const n of names) {
      let rows;
      try { const c = JSON.parse(fs.readFileSync(path.join(cacheDir, n), 'utf8')); rows = Array.isArray(c.rows) ? c.rows : Object.values(c.rows || {}); } catch { continue; }
      rows = rows.filter((r) => r && typeof r.date === 'string');
      if (rows.length) { merge(n.replace(/-scan\.json$/, ''), rows); dirty = true; }
    }
    flush();
  }
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!dirty) return false;
    if (writeCacheJson(file, data)) { dirty = false; lastFlush = now(); return true; }
    return false;
  };
  const schedule = () => {
    if (timer || !dirty) return;
    const wait = Math.max(0, flushMs - (now() - lastFlush));
    timer = setTimeout(flush, wait); timer.unref?.();
  };

  // rows：渠道本次返回的行。返回「归档 ∪ 当前」逐字段取大后的行（不改动入参）
  function merge(channel, rows) {
    const d = load(), arch = d.ch[channel] || (d.ch[channel] = {});
    const settled = localDate(now() - SETTLE_DAYS * 86400000); // ≤ 这一天的才入档/补回
    const out = new Map();
    for (const r of rows || []) {
      if (!r || typeof r.date !== 'string') continue;
      const k = rowKey(r);
      const cur = out.get(k);
      if (cur) { for (const f of NUM) if (r[f] != null) cur[f] = (cur[f] || 0) + r[f]; } // 同键多行先加起来（适配器本就可能分行返回）
      else out.set(k, { ...r });
    }
    for (const [k, r] of out) {
      if (r.date > settled) continue;
      const a = arch[k];
      if (!a) { arch[k] = { ...r }; dirty = true; continue; }
      for (const f of NUM) {
        if (r[f] == null && a[f] == null) continue;
        const m = Math.max(r[f] || 0, a[f] || 0);
        if (m > (a[f] || 0)) { a[f] = m; dirty = true; }
        r[f] = m;
      }
    }
    for (const [k, a] of Object.entries(arch)) { // 当前没有、归档里有：补回（只补稳定日期）
      if (out.has(k) || a.date > settled) continue;
      out.set(k, { ...a });
    }
    schedule();
    return [...out.values()];
  }

  // 把一批会话的用量从旧键挪到新键。items: [{ id, remove: 旧行, add: 新行 }]。
  // 先按键汇总扣掉旧行（最多扣到 0，现有会话复现不出的老数据原样留着），再把已稳定日期的新行加回。
  // id 和数据在同一次原子写里落盘，重复调用不会扣两次。返回 true = 已经写到磁盘。
  function rekey(channel, items) {
    const d = load();
    const done = (d.rekeys ||= {})[channel] ||= {};
    const todo = items.filter((it) => !done[it.id]);
    if (todo.length) {
      const arch = d.ch[channel] || (d.ch[channel] = {});
      const settled = localDate(now() - SETTLE_DAYS * 86400000);
      const byKey = (rows) => {
        const m = new Map();
        for (const r of rows) {
          const k = rowKey(r), cur = m.get(k);
          if (cur) { for (const f of NUM) if (r[f] != null) cur[f] = (cur[f] || 0) + r[f]; } else m.set(k, { ...r });
        }
        return m;
      };
      try { if (!fs.existsSync(`${file}.pre-rekey`)) fs.copyFileSync(file, `${file}.pre-rekey`); }
      catch (e) { if (e.code !== 'ENOENT') console.warn(`[archive] 迁移前备份失败：${e.message}`); }
      for (const [k, r] of byKey(todo.flatMap((it) => it.remove))) {
        const a = arch[k];
        if (!a) continue;
        for (const f of NUM) if (r[f]) a[f] = Math.max(0, (a[f] || 0) - r[f]);
        if ([...NUM].every((f) => !a[f])) delete arch[k];
      }
      for (const [k, r] of byKey(todo.flatMap((it) => it.add).filter((r) => r.date <= settled))) {
        const a = arch[k];
        if (!a) arch[k] = r;
        else for (const f of NUM) if (r[f] != null) a[f] = (a[f] || 0) + r[f];
      }
      for (const it of todo) done[it.id] = 1;
      dirty = true;
    }
    return dirty ? flush() : true;
  }

  function drop(channel, date) { // 人工修正：删某渠道某天的归档
    const d = load(), arch = d.ch[channel] || {}; let n = 0;
    for (const [k, a] of Object.entries(arch)) if (a.date === date) { delete arch[k]; n++; }
    if (n) { dirty = true; flush(); }
    return n;
  }
  function stats() {
    const d = load();
    return Object.fromEntries(Object.entries(d.ch).map(([c, arch]) => {
      const rows = Object.values(arch), dates = rows.map((r) => r.date).sort();
      return [c, { rows: rows.length, from: dates[0] || null, to: dates.at(-1) || null, tokens: rows.reduce((s, r) => s + (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0), 0) }];
    }));
  }
  load(); // 立刻加载：首次创建时要趁渠道还没改写缓存，把升级前的历史行收进来（见 seedFromCaches）
  return { merge, rekey, flush, drop, stats, _data: () => load() };
}
