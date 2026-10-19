// cache-util.mjs — 扫描缓存的读写保护。
// 背景：缓存（server/.cache/*.json）是累计历史的唯一副本——Codex/Claude 的老会话文件会被压缩、归档、清理，
// 一旦缓存被「读失败 → 当成空缓存 → 重扫 → 覆盖写回」，历史就永久丢了（实际发生过：Codex 把老会话压成 .zst 后，缓存被重置，数十亿 token 的历史一次性丢失）。
// 所以：
//   读：瞬时 I/O 错误（iCloud 卡住等）重试；文件坏了就回退到最近的每日备份；仍读不出来才让调用方当「空缓存」，
//       同时记下这个文件「读失败过」。
//   写：原子写（临时文件 + rename）；每天第一次写前留一份 .bak-YYYYMMDD（保留 7 份）；
//       新内容比旧内容小一半以上时，先把旧的留成 .shrink-时间戳（保留 3 份）；
//       读失败过且旧文件还读不出来（可能只是 iCloud 暂时卡住）→ 放弃本次写入，绝不覆盖；
//       旧文件能读但解析不了（真损坏）→ 先挪成 .corrupt-时间戳再写。
import fs from 'node:fs';
import path from 'node:path';

const loadFailed = new Set(); // 读失败过的文件
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const day = () => new Date().toLocaleDateString('sv-SE').replace(/-/g, '');
const siblings = (file, tag) => {
  const dir = path.dirname(file), base = path.basename(file) + '.' + tag + '-';
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort().map((n) => path.join(dir, n)); } catch { return []; }
};
const prune = (file, tag, keep) => { const l = siblings(file, tag); for (const p of l.slice(0, Math.max(0, l.length - keep))) { try { fs.unlinkSync(p); } catch {} } };

export function readCacheJson(file) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') throw e; // 没有文件 = 首次运行，正常
      lastErr = e;
      if (!(e instanceof SyntaxError)) sleepMs(300); // I/O 错误才值得重试；解析错误重试没用
      else break;
    }
  }
  for (const b of siblings(file, 'bak').reverse()) { // 最近的备份优先
    try {
      const c = JSON.parse(fs.readFileSync(b, 'utf8'));
      console.warn(`[cache] ${path.basename(file)} 读取失败（${lastErr.code || lastErr.message}），已回退到备份 ${path.basename(b)}`);
      loadFailed.add(file);
      return c;
    } catch {}
  }
  loadFailed.add(file);
  console.warn(`[cache] ${path.basename(file)} 读取失败且无可用备份（${lastErr.code || lastErr.message}），本轮按空缓存处理；旧文件不会被覆盖`);
  throw lastErr;
}

export function writeCacheJson(file, obj) {
  const text = JSON.stringify(obj);
  let existing = null;
  try { existing = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') existing = false; } // false = 存在但读不了
  if (existing === false && loadFailed.has(file)) {
    console.warn(`[cache] ${path.basename(file)} 现在读不了，放弃本次写入（保护旧文件，下一轮重试）`);
    return false;
  }
  if (existing) {
    let parsable = true;
    try { JSON.parse(existing.toString('utf8')); } catch { parsable = false; }
    try {
      if (!parsable) { fs.copyFileSync(file, `${file}.corrupt-${stamp()}`); prune(file, 'corrupt', 3); }
      else {
        const bak = `${file}.bak-${day()}`;
        if (!fs.existsSync(bak)) { fs.writeFileSync(bak, existing); prune(file, 'bak', 7); }
        if (existing.length > 20_000 && text.length < existing.length * 0.5) {
          fs.copyFileSync(file, `${file}.shrink-${stamp()}`); prune(file, 'shrink', 3);
          console.warn(`[cache] ${path.basename(file)} 新内容比旧内容小一半以上（${existing.length} → ${text.length} 字节），旧文件已另存为 .shrink-*`);
        }
      }
    } catch (e) { console.warn(`[cache] ${path.basename(file)} 备份失败：${e.message}`); }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    loadFailed.delete(file);
    return true;
  } catch (e) { console.warn(`[cache] ${path.basename(file)} 写入失败：${e.message}`); return false; }
}
