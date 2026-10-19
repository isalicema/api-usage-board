import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const u=await import(new URL('../../cache-util.mjs', import.meta.url).href);
const D=fs.mkdtempSync(path.join(os.tmpdir(),'cu-')); const F=path.join(D,'x.json'); const ls=()=>fs.readdirSync(D).sort();
const warns=[]; const w=console.warn; console.warn=(m)=>warns.push(m);
const big=(n)=>({rows:Object.fromEntries(Array.from({length:n},(_,i)=>['k'+i,{a:i,pad:'x'.repeat(50)}]))});
// 1) 不存在 → ENOENT(调用方当首次运行);写入后可读,留一份当日备份
assert.throws(()=>u.readCacheJson(F),(e)=>e.code==='ENOENT'); assert.equal(u.writeCacheJson(F,big(400)),true); assert.deepEqual(u.readCacheJson(F),big(400)); assert.equal(ls().filter(n=>n.includes('.bak-')).length,0,'首次写没有旧文件可备份');
assert.equal(u.writeCacheJson(F,big(410)),true); assert.equal(ls().filter(n=>n.includes('.bak-')).length,1,'第二次写前留当日备份'); u.writeCacheJson(F,big(420)); assert.equal(ls().filter(n=>n.includes('.bak-')).length,1,'同一天只留一份');
// 2) 备份保留 7 份
for(let i=1;i<=9;i++) fs.writeFileSync(F+'.bak-2020010'+i,'{}'); u.writeCacheJson(F,big(430)); u.writeCacheJson(F,big(431)); // 触发 prune 需要新建 bak:当日已有→不触发,这里直接验证旧日期被清
fs.unlinkSync(F+'.bak-'+new Date().toLocaleDateString('sv-SE').replace(/-/g,'')); u.writeCacheJson(F,big(432)); assert.ok(ls().filter(n=>n.includes('.bak-')).length<=7,'备份最多 7 份');
// 3) 缩水保护:新内容 <50% → 旧的另存 .shrink-*
warns.length=0; u.writeCacheJson(F,{rows:{}}); assert.ok(ls().some(n=>n.includes('.shrink-')),'缩水前另存旧文件'); assert.ok(warns.some(m=>m.includes('小一半')));
// 4) 文件损坏:回退到最近的备份,并提示
fs.writeFileSync(F,'{坏的'); warns.length=0; const r=u.readCacheJson(F); assert.ok(r&&typeof r==='object'); assert.ok(warns.some(m=>m.includes('回退到备份')));
// 5) 损坏文件被覆盖前先挪成 .corrupt-*
u.writeCacheJson(F,big(500)); assert.ok(ls().some(n=>n.includes('.corrupt-')),'损坏文件先另存');
// 6) 无备份 + 损坏:读抛错(调用方当空缓存),但写入时旧文件被保留成 .corrupt-*,不静默丢失
const G=path.join(D,'g.json'); fs.writeFileSync(G,'{坏'); assert.throws(()=>u.readCacheJson(G)); u.writeCacheJson(G,big(10)); assert.ok(ls().some(n=>n.startsWith('g.json.corrupt-')));
// 7) 读不了(权限/I/O)+ 之前读失败过 → 放弃写入,旧文件原样不动
const H=path.join(D,'h.json'); u.writeCacheJson(H,big(300)); const before=fs.readFileSync(H,'utf8'); fs.chmodSync(H,0o000);
try{ fs.readFileSync(H); console.warn=w; console.log('（当前用户可读 000 权限文件，跳过第 7 项）'); console.warn=(m)=>warns.push(m) }catch{
  assert.throws(()=>u.readCacheJson(H)); warns.length=0; assert.equal(u.writeCacheJson(H,{rows:{}}),false,'读不了就不写'); assert.ok(warns.some(m=>m.includes('放弃本次写入'))); fs.chmodSync(H,0o644); assert.equal(fs.readFileSync(H,'utf8'),before,'旧文件原样'); }
fs.chmodSync(H,0o644);
// 8) 原子写:不留 .tmp
assert.ok(!ls().some(n=>n.includes('.tmp-')));
console.warn=w; fs.rmSync(D,{recursive:true,force:true}); console.log('缓存保护测试通过: 首次ENOENT/当日备份/备份保留7份/缩水另存/损坏回退备份/损坏覆盖前另存/无备份损坏不丢旧文件/读不了就不写/原子写');
