#!/usr/bin/env node
// 查看 / 修正每日用量归档（见 server/history-archive.mjs）。
//   node server/tools/archive.mjs stats                  各渠道归档范围与 token 合计
//   node server/tools/archive.mjs drop <渠道> <YYYY-MM-DD>   删掉某渠道某天的归档（修正「往下改」时用，之后让渠道重新扫出正确值）
// 改归档前先停看板服务（服务内存里有一份，会把旧值写回）。
import { createArchive } from '../history-archive.mjs';
const [cmd, ch, date] = process.argv.slice(2);
const a = createArchive({ flushMs: 0 });
if (cmd === 'stats') {
  for (const [c, s] of Object.entries(a.stats())) console.log(`${c.padEnd(12)} ${String(s.rows).padStart(5)} 行  ${s.from} ~ ${s.to}  ${(s.tokens / 1e8).toFixed(2)} 亿`);
} else if (cmd === 'drop' && ch && /^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
  console.log(`已删除 ${ch} ${date} 的归档 ${a.drop(ch, date)} 行`);
} else { console.log('用法：archive.mjs stats | drop <渠道> <YYYY-MM-DD>'); process.exit(1); }
