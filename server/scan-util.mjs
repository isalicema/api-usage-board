// scan-util.mjs — 增量扫描共享工具
import fs from 'node:fs';

const CHUNK = 16 * 1024 * 1024; // 16MB，单文件最大 563M，必须分块读

// 从 offset 起分块读文件，对每个完整行回调 onLine；返回新的安全 offset（不完整末行留给下轮）。
// 容忍正在实时写入的文件。
export function readNewLines(filePath, offset, onLine) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return offset; }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return offset;
    let pos = offset;
    let carry = ''; // 跨块的不完整行
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const n = Math.min(CHUNK, size - pos);
      fs.readSync(fd, buf, 0, n, pos);
      pos += n;
      carry += buf.subarray(0, n).toString('utf8');
      let idx;
      while ((idx = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        if (line) onLine(line);
      }
    }
    return pos - Buffer.byteLength(carry); // carry 是未完成的行，下轮重读
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
