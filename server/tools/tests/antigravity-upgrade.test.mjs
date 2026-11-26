// 升级路径：旧版 Antigravity 适配器把日期归错（拿第几次生成当步骤号），历史归档按错日期记了账。
// 要求：升级后用量挪到正确日期、不重复计数；已删除/归档独有的历史不丢；读失败的会话不动归档；中途崩溃重跑不扣两次。
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const SRC = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-')); const HOME = path.join(T, 'home'); const SRV = path.join(T, 'server');
fs.cpSync(SRC, SRV, { recursive: true, filter: (p) => !/\/(\.cache|data|tools)(\/|$)/.test(p) });
fs.mkdirSync(path.join(SRV, '.cache'), { recursive: true }); process.env.HOME = HOME;

const d = (n) => { const t = new Date(Date.now() - n * 86400000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const varint = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; o.push(b); } while (n); return Buffer.from(o); };
const num = (f, v) => Buffer.concat([varint(f << 3), varint(v)]);
const bytes = (f, b) => Buffer.concat([varint((f << 3) | 2), varint(b.length), b]);
// 一条生成记录：field 2 = 本次产出的步骤号；field 1 → field 4 = usage（input / output）
const gen = (steps, input, output) => Buffer.concat([
  bytes(2, Buffer.concat(steps.map(varint))),
  bytes(1, Buffer.concat([bytes(4, Buffer.concat([num(1, input), num(3, output)])), bytes(19, Buffer.from('gemini-test'))])),
]);
const dbFile = (root, cid) => path.join(HOME, '.gemini', root, 'conversations', `${cid}.db`);
function session(root, cid, stepDays, gens) { // stepDays: { 步骤号: 几天前 }
  const db = dbFile(root, cid); fs.mkdirSync(path.dirname(db), { recursive: true }); fs.rmSync(db, { force: true });
  const h = new DatabaseSync(db); h.exec('CREATE TABLE gen_metadata (idx integer primary key, data blob)');
  gens.forEach((g, i) => h.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(i, g)); h.close();
  const logs = path.join(HOME, '.gemini', root, 'brain', cid, '.system_generated', 'logs'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), Object.entries(stepDays)
    .map(([s, n]) => JSON.stringify({ step_index: Number(s), created_at: `${d(n)}T12:00:00.000Z` })).join('\n') + '\n');
}
const row = (date, input) => ({ date, model: 'gemini-test', cwd: null, input, output: 0, cacheRead: 0 });

// A（CLI）跨天：步骤 0 在 10 天前，步骤 5 在 5 天前。旧版把第 2 条记录当成步骤 1 → 全记到 10 天前
session('antigravity-cli', 'aaaa', { 0: 10, 1: 10, 5: 5 }, [gen([0, 1], 1000, 0), gen([5], 300, 0)]);
// B（客户端）：旧版完全没扫到；与 A 同一天同模型 → 归档里是同一个键
session('antigravity', 'bbbb', { 0: 10 }, [gen([0], 50, 0)]);
// C（CLI）这次读不出来（文件损坏）
fs.writeFileSync(dbFile('antigravity-cli', 'cccc'), 'not a database');
// D（CLI）会话仍在更新，但正确日期早于扫描窗口；旧版记在窗口内
session('antigravity-cli', 'dddd', { 0: 20, 3: 200 }, [gen([0], 5, 0), gen([3], 40, 0)]);

// 旧版缓存 v1。Y 是已删除的会话；归档在 10 天前那个键上比现有会话能复现的多 7000
const oldFiles = {
  [dbFile('antigravity-cli', 'aaaa')]: [row(d(10), 1000), row(d(10), 300)],
  [dbFile('antigravity-cli', 'cccc')]: [row(d(15), 600)],
  [dbFile('antigravity-cli', 'dddd')]: [row(d(20), 5), row(d(20), 40)],
};
const CACHE = path.join(SRV, '.cache', 'antigravity-scan.json');
const v1 = JSON.stringify({ v: 1, files: Object.fromEntries(Object.entries(oldFiles).map(([p, rows]) => [p, { mtimeMs: 1, size: 1, rows }])),
  rows: { a: row(d(10), 1300), c: row(d(15), 600), d: row(d(20), 45) } });
fs.writeFileSync(CACHE, v1);
const ARCH = path.join(SRV, 'data', 'history-archive.json'); fs.mkdirSync(path.dirname(ARCH), { recursive: true });

const { createArchive } = await import(path.join(SRV, 'history-archive.mjs'));
const { createAntigravityAdapter } = await import(path.join(SRV, 'adapters/antigravity.mjs'));
const seed = createArchive({ file: ARCH, flushMs: 0 }); // 首次建归档：收进旧缓存
seed.merge('antigravity', [row(d(10), 1300 + 7000), row(d(15), 600), row(d(20), 45), row(d(30), 7777)]);
seed.merge('codex', [row(d(10), 123)]); seed.flush();

const run = async () => { // 一次「重启服务 + 请求」
  const archive = createArchive({ file: ARCH, flushMs: 0 });
  const rows = archive.merge('antigravity', await createAntigravityAdapter({ archive }).usageRows());
  archive.flush(); return rows;
};
const day = (rows, n) => rows.filter((r) => r.date === d(n)).reduce((s, r) => s + r.input + r.output + r.cacheRead, 0);
const check = (rows, label, c) => {
  assert.equal(day(rows, 10), 1000 + 50 + 7000, `${label}: A 的第一条 + 客户端 B + 归档独有差额`);
  assert.equal(day(rows, 5), 300, `${label}: A 的第二条挪到正确日期`);
  assert.equal(day(rows, 15), c, `${label}: 会话 C`);
  assert.equal(day(rows, 20), 5, `${label}: D 窗口内部分`);
  assert.equal(day(rows, 200), 40, `${label}: D 的更早日期进了归档，没因为超出扫描窗口丢掉`);
  assert.equal(day(rows, 30), 7777, `${label}: 已删除会话的历史还在`);
};

check(await run(), '首次升级', 600);
assert.equal(JSON.parse(fs.readFileSync(CACHE, 'utf8')).v, 2);
check(await run(), '再次重启', 600);
fs.writeFileSync(CACHE, v1); // 模拟：归档已落盘，新缓存没写成就崩了
check(await run(), '崩溃后重跑', 600);

// C 恢复可读，且正确日期是 14 天前
session('antigravity-cli', 'cccc', { 0: 15, 4: 14 }, [gen([0], 100, 0), gen([4], 500, 0)]);
const fixed = await run(); check(fixed, 'C 恢复后', 100);
assert.equal(day(fixed, 14), 500, 'C 恢复后才换键');
assert.deepEqual(JSON.parse(fs.readFileSync(CACHE, 'utf8')).legacy, {}, '待迁移清单清空');
assert.equal(createArchive({ file: ARCH, flushMs: 0 }).stats().codex.tokens, 123, '其他渠道不受影响');

// 全新安装：没有旧缓存、没有归档
fs.rmSync(path.join(SRV, 'data'), { recursive: true }); fs.rmSync(path.join(SRV, '.cache'), { recursive: true });
const fresh = await run();
assert.equal(fresh.reduce((s, r) => s + r.input, 0), 1000 + 300 + 50 + 100 + 500 + 5, '全新安装按扫描窗口计数');
assert.equal((await run()).reduce((s, r) => s + r.input, 0), 1955);
fs.rmSync(T, { recursive: true, force: true });
console.log('Antigravity 升级测试通过: 换日期不重复计数/客户端计入/删除与归档独有历史不丢/读失败不动归档/崩溃重跑幂等/全新安装');
