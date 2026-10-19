import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import zlib from 'node:zlib';
const HOME=fs.mkdtempSync(path.join(os.tmpdir(),'zsthome-')); process.env.HOME=HOME;
const x=await import(new URL('../../adapters/codex.mjs', import.meta.url).href);
const TD=new Date(), pad=(n)=>String(n).padStart(2,'0'); const SES=HOME+`/.codex/sessions/${TD.getFullYear()}/${pad(TD.getMonth()+1)}/${pad(TD.getDate())}`, ARC=HOME+'/.codex/archived_sessions'; fs.mkdirSync(SES,{recursive:true}); fs.mkdirSync(ARC,{recursive:true});
const ts=new Date().toISOString();
const tc=(n,pad=0)=>JSON.stringify({type:'event_msg',timestamp:ts,payload:{type:'token_count',info:{last_token_usage:{input_tokens:n,cached_input_tokens:0,output_tokens:1,cache_write_input_tokens:0}},pad:'x'.repeat(pad)}});
const ctx=(m,c)=>JSON.stringify({type:'turn_context',payload:{model:m,cwd:c}});
const body=(ns,pad=0)=>[ctx('gpt-t','/p'),...ns.map(n=>tc(n,pad))].join('\n')+'\n';
const total=(cache)=>Object.values(cache.rows).reduce((s,r)=>s+r.input+r.output+r.cacheRead+r.cacheWrite,0);
const st=(p)=>{const s=fs.statSync(p);return{path:p,size:s.size,mtimeMs:s.mtimeMs}};
const fresh=()=>({v:3,files:{},rows:{},zdone:{}}); const KEEP='2000-01-01';
const KEY=`rollout-${TD.getFullYear()}-${pad(TD.getMonth()+1)}-${pad(TD.getDate())}T10-00-00-aaaa`;
// 1) 仅有 .zst、缓存为空：整份读入（含跨块长行：每行 ~200KB > 流块）
let c=fresh(); const p1=`${SES}/${KEY}.jsonl.zst`; fs.writeFileSync(p1,zlib.zstdCompressSync(Buffer.from(body([10,20,30,40],200_000))));
await x._scanLocal(c,[st(p1)],KEEP); assert.equal(total(c),10+1+20+1+30+1+40+1); assert.equal(c.zdone[KEY],1);
await x._scanLocal(c,[st(p1)],KEEP); assert.equal(total(c),104,'再扫一遍不重复');
// 2) jsonl 读到一半，随后被压缩成 .zst（内容更长）：从原偏移接着读，总数 = 全文一次
c=fresh(); const pj=`${SES}/${KEY}.jsonl`; fs.writeFileSync(pj,body([10,20])); await x._scanLocal(c,[st(pj)],KEEP); assert.equal(total(c),32);
fs.writeFileSync(pj,body([10,20,30,40])); fs.unlinkSync(pj); fs.writeFileSync(p1,zlib.zstdCompressSync(Buffer.from(body([10,20,30,40]))));
await x._scanLocal(c,[st(p1)],KEEP); assert.equal(total(c),10+1+20+1+30+1+40+1,'压缩后只补读新增部分'); assert.equal(Object.keys(c.files).length,0,'旧 jsonl 记录已迁走');
await x._scanLocal(c,[st(p1)],KEEP); assert.equal(total(c),104);
// 3) 同一会话 .jsonl 与 .zst 并存：列表只留 .jsonl
fs.writeFileSync(pj,body([5])); const l=x._listSessionFiles().filter(f=>x._sessionKey(f.path)===KEY); assert.equal(l.length,1); assert.ok(l[0].path.endsWith('.jsonl'));
fs.unlinkSync(pj);
// 4) 会话从 sessions 挪到 archived_sessions（仍是 .jsonl）：沿用偏移，不重复
c=fresh(); const K2=`rollout-${TD.getFullYear()}-${pad(TD.getMonth()+1)}-${pad(TD.getDate())}T11-00-00-bbbb`; const a=`${SES}/${K2}.jsonl`, b=`${ARC}/${K2}.jsonl`; fs.writeFileSync(a,body([7,8])); await x._scanLocal(c,[st(a)],KEEP); assert.equal(total(c),17);
fs.renameSync(a,b); await x._scanLocal(c,[st(b)],KEEP); assert.equal(total(c),17,'挪位置不重复'); fs.appendFileSync(b,tc(100)+'\n'); await x._scanLocal(c,[st(b)],KEEP); assert.equal(total(c),118,'挪后新增照常增量');
// 5) 压缩文件损坏（截断）：不留半截行、不标记完成；修好后一次读入
c=fresh(); const K3=`rollout-${TD.getFullYear()}-${pad(TD.getMonth()+1)}-${pad(TD.getDate())}T12-00-00-cccc`; const p3=`${SES}/${K3}.jsonl.zst`; const good=zlib.zstdCompressSync(Buffer.from(body([1,2,3],50_000)));
fs.writeFileSync(p3,good.subarray(0,Math.floor(good.length/2))); const w=console.warn; let warned=0; console.warn=()=>warned++;
await x._scanLocal(c,[st(p3)],KEEP); console.warn=w; assert.equal(total(c),0,'失败不留半截'); assert.ok(!c.zdone[K3]); assert.ok(warned>=1);
fs.writeFileSync(p3,good); await x._scanLocal(c,[st(p3)],KEEP); assert.equal(total(c),1+1+2+1+3+1);
// 6) 已整份读过的会话，同名 .jsonl 又出现：跳过
fs.writeFileSync(`${SES}/${K3}.jsonl`,body([999])); await x._scanLocal(c,[st(`${SES}/${K3}.jsonl`)],KEEP); assert.equal(total(c),9,'zdone 的会话不再读同名文件');
// 7) 无结尾换行的末行也读到
c=fresh(); const K4=`rollout-${TD.getFullYear()}-${pad(TD.getMonth()+1)}-${pad(TD.getDate())}T13-00-00-dddd`; const p4=`${SES}/${K4}.jsonl.zst`; fs.writeFileSync(p4,zlib.zstdCompressSync(Buffer.from([ctx('m','/q'),tc(5)].join('\n')))); await x._scanLocal(c,[st(p4)],KEEP); assert.equal(total(c),6);
fs.rmSync(HOME,{recursive:true,force:true}); console.log('Codex .zst 读取测试通过: 仅zst整读(含跨块长行)/压缩时从原偏移续读不重复/jsonl与zst并存只留jsonl/挪位置不重复/损坏不留半截可重试/已读过的会话不再读/无结尾换行');
