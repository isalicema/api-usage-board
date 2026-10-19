import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const { createArchive, SETTLE_DAYS } = await import(new URL('../../history-archive.mjs', import.meta.url).href);
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')); const F = path.join(D, 'a.json');
const NOW = Date.parse('2026-10-19T12:00:00+08:00'); let clock = NOW; const now = () => clock;
const mk = (date, model, input, extra = {}) => ({ date, model, cwd: '/p', input, output: 1, cacheRead: 2, cacheWrite: 0, ...extra });
const tot = (rows) => rows.reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
const A = () => createArchive({ file: F, cacheDir: null, flushMs: 0, now });
let a = A();
// 1) 稳定日期入档;近 SETTLE_DAYS 天不入档也不被补回
const r1 = a.merge('codex', [mk('2026-08-13', 'm', 1000), mk('2026-10-18', 'm', 5), mk('2026-10-19', 'm', 7)]);
assert.equal(tot(r1), 1003 + 8 + 10); a.flush();
const saved = JSON.parse(fs.readFileSync(F, 'utf8')).ch.codex; assert.deepEqual(Object.values(saved).map((r) => r.date), ['2026-08-13'], '只有稳定日期入档(10-18、10-19 太新)');
// 2) 缓存被重置:当前行没了/变小 → 归档补回,累计不缩水
a = A();
assert.equal(tot(a.merge('codex', [])), 1003, '当前为空 → 全部由归档补回');
assert.equal(tot(a.merge('codex', [mk('2026-08-13', 'm', 300)])), 1003, '当前偏小(部分重建) → 取较大值,不缩水');
// 3) 当前更大(迟到的回补事件) → 取更大并更新归档
assert.equal(tot(a.merge('codex', [mk('2026-08-13', 'm', 1500)])), 1503); a.flush(); a = A();
assert.equal(tot(a.merge('codex', [])), 1503, '归档已更新为更大值');
// 4) 幂等:反复合并同一批不会累加
for (let i = 0; i < 5; i++) a.merge('codex', [mk('2026-08-13', 'm', 1500)]); assert.equal(tot(a.merge('codex', [mk('2026-08-13', 'm', 1500)])), 1503);
// 5) 窗口滚动:渠道不再返回老日期,累计仍含它;再叠加新日期是往上加
const r5 = a.merge('codex', [mk('2026-10-01', 'm', 40)]); assert.equal(tot(r5), 1503 + 43);
// 6) 渠道之间互不影响;同键多行先合并;字段身份(model/cwd/bf)区分行
assert.equal(tot(a.merge('claude', [mk('2026-08-13', 'm', 9), mk('2026-08-13', 'm', 1)])), 10 + 2 + 4, '同键多行先加起来');
assert.equal(a.merge('claude', []).filter((r) => r.model === 'm').length, 1, 'claude 与 codex 互不影响')
const rb = a.merge('claude', [mk('2026-07-01', 'x', 3, { bf: 1 }), mk('2026-07-01', 'x', 4)]); assert.equal(rb.filter((r) => r.date === '2026-07-01').length, 2, 'bf 不同视为不同行');
// 7) drop 修正:删掉那天之后,以当前为准
const day = (rows, d) => tot(rows.filter((r) => r.date === d));
a.drop('codex', '2026-08-13'); a.flush(); a = A(); assert.equal(day(a.merge('codex', [mk('2026-08-13', 'm', 100)]), '2026-08-13'), 103, 'drop 之后以当前扫描为准(往下修正生效)'); assert.equal(day(a.merge('codex', []), '2026-08-13'), 103)
// 8) 随时间推移:原来太新的日期过了 SETTLE_DAYS 才入档
clock = NOW + (SETTLE_DAYS + 1) * 86400000; const r8 = a.merge('codex', [mk('2026-10-19', 'm', 7)]); a.flush();
assert.ok(Object.values(JSON.parse(fs.readFileSync(F, 'utf8')).ch.codex).some((r) => r.date === '2026-10-19'), '10-19 现在稳定了,入档');
// 9) 归档文件损坏 → 回退备份/空档,不抛错;入参不被改动
const inRows = [mk('2026-08-13', 'm', 11)]; const snap = JSON.stringify(inRows); a.merge('codex', inRows); assert.equal(JSON.stringify(inRows), snap, '不改入参');
fs.writeFileSync(F, '{坏'); const w = console.warn; console.warn = () => {}; const b = createArchive({ file: F, cacheDir: null, flushMs: 0, now }); assert.doesNotThrow(() => b.merge('codex', inRows)); console.warn = w;
fs.rmSync(D, { recursive: true, force: true });
console.log('历史归档测试通过: 稳定日期入档/近几天不入档/缓存重置补回/部分重建取大值/迟到回补更新归档/幂等/窗口滚动不缩水/渠道隔离/drop 修正/随时间入档/损坏不抛错');

// 10) 首次创建归档时，从升级前的缓存（<渠道>-scan.json，行在 rows 字典或数组里）收一份；之后缓存被清空，累计不缩水
{
  clock = NOW; // 前面的用例把时钟拨快过
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ha2-')); const CD = path.join(D2, 'cache'); fs.mkdirSync(CD);
  const old = (date, input) => mk(date, 'm', input);
  fs.writeFileSync(path.join(CD, 'codex-scan.json'), JSON.stringify({ v: 3, files: {}, rows: { a: old('2026-07-02', 500), b: old('2026-10-19', 9) } }));
  fs.writeFileSync(path.join(CD, 'openrouter-analytics.json'), JSON.stringify({ ts: 1, rows: [old('2026-07-02', 77)] })); // 非 -scan.json，不收
  fs.writeFileSync(path.join(CD, 'claude-scan.json'), JSON.stringify({ v: 1, rows: [old('2026-07-03', 40)] })); // 数组形式
  const F2 = path.join(D2, 'arch.json');
  const s = createArchive({ file: F2, cacheDir: CD, flushMs: 0, now });
  assert.equal(tot(s.merge('codex', [])), 503, '升级前缓存里的稳定日期行被收进归档（10-19 太新不收）');
  assert.equal(tot(s.merge('claude', [])), 43); assert.equal(tot(s.merge('openrouter', [])), 0);
  fs.rmSync(path.join(CD, 'codex-scan.json')); // 缓存被清空/重建
  const s2 = createArchive({ file: F2, cacheDir: CD, flushMs: 0, now });
  assert.equal(tot(s2.merge('codex', [])), 503, '归档已存在，不再重复收；缓存没了历史仍在');
  fs.writeFileSync(path.join(CD, 'codex-scan.json'), JSON.stringify({ v: 4, rows: { a: old('2026-07-02', 99999) } }));
  assert.equal(tot(createArchive({ file: F2, cacheDir: CD, flushMs: 0, now }).merge('codex', [])), 503, '归档存在后不会再从缓存里收（避免重复/误收）');
  fs.rmSync(D2, { recursive: true, force: true });
  console.log('归档首次创建时从升级前缓存收历史：通过');
}
