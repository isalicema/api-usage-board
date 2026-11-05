// 升级路径：旧版本（只读 .jsonl）留下的 Codex 缓存 + 磁盘上后来被压成 .zst / 被删掉的会话。
// 要求：压缩过的会话不重复计数；已删除会话的历史不丢（旧缓存先被收进归档）。
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import zlib from 'node:zlib';
const SRC = fileURLToPathLike(new URL('../../', import.meta.url));
function fileURLToPathLike(u) { return decodeURIComponent(u.pathname).replace(/\/$/, ''); }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-')); const HOME = path.join(T, 'home'); const SRV = path.join(T, 'server');
fs.cpSync(SRC, SRV, { recursive: true, filter: (p) => !/\/(\.cache|data|tools)(\/|$)/.test(p) });
fs.mkdirSync(path.join(SRV, '.cache'), { recursive: true }); process.env.HOME = HOME;

const d = (n) => { const t = new Date(Date.now() - n * 86400000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const OLD = d(10), RECENT = d(0); // OLD 是稳定日期（会被归档），RECENT 是今天
const iso = (date) => `${date}T12:00:00.000Z`;
const line = (date, n) => JSON.stringify({ type: 'event_msg', timestamp: iso(date), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0 } } } });
const ctx = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-t', cwd: '/proj' } });
const sessDir = (date) => { const [y, m, dd] = date.split('-'); const p = path.join(HOME, '.codex', 'sessions', y, m, dd); fs.mkdirSync(p, { recursive: true }); return p; };

// 会话 X：旧版本当 .jsonl 读过（1000 token，旧缓存里有这些行，但已没有 X 的读取记录），之后被压成 .zst
const X = `rollout-${OLD}T10-00-00-xxxx`; fs.writeFileSync(path.join(sessDir(OLD), `${X}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from([ctx, line(OLD, 1000)].join('\n') + '\n')));
// 会话 Z：新会话，只在磁盘上（200 token）
const Z = `rollout-${RECENT}T10-00-00-zzzz`; fs.writeFileSync(path.join(sessDir(RECENT), `${Z}.jsonl`), [ctx, line(RECENT, 200)].join('\n') + '\n');
// 旧缓存（v3）：X 的 1000（读取记录已被清掉）+ 已被删除的会话 Y 的 7777（磁盘上已不存在）
const row = (date, input) => ({ date, model: 'gpt-t', cwd: '/proj', input, output: 0, cacheRead: 0, cacheWrite: 0 });
const OLDCACHE = path.join(SRV, '.cache', 'codex-scan.json');
fs.writeFileSync(OLDCACHE, JSON.stringify({ v: 3, files: {}, rows: { x: row(OLD, 1000), y: row(d(20), 7777) } }));

// 模拟 server 启动顺序：先建归档（此时收旧缓存），再让渠道扫描
const { createArchive } = await import(path.join(SRV, 'history-archive.mjs'));
const { createCodexAdapter } = await import(path.join(SRV, 'adapters/codex.mjs'));
const archive = createArchive({ file: path.join(SRV, 'data', 'history-archive.json'), flushMs: 0 });
const adapter = createCodexAdapter();
const tot = (rows) => rows.reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
const byDay = (rows, day) => tot(rows.filter((r) => r.date === day));
const rows = archive.merge('codex', await adapter.usageRows());
assert.equal(byDay(rows, OLD), 1000, 'X 被压成 .zst 后不重复计数（旧缓存作废、全量重建，且与归档取较大值）');
assert.equal(byDay(rows, d(20)), 7777, '磁盘上已不存在的会话 Y，历史从旧缓存收进归档，没丢');
assert.equal(byDay(rows, RECENT), 200, '新会话照常');
assert.equal(JSON.parse(fs.readFileSync(OLDCACHE, 'utf8')).v, 5, '缓存升到 v5');
const again = archive.merge('codex', await adapter.usageRows()); assert.equal(tot(again), tot(rows), '再扫一遍不变');
fs.rmSync(T, { recursive: true, force: true });
console.log('升级路径测试通过: 压成 .zst 的会话不重复计数/已删除会话的历史进归档不丢/缓存升 v4/重复扫描不变');
