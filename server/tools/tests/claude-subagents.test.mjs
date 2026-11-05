// Claude Code 子智能体日志：<项目>/<会话id>/subagents/agent-*.jsonl 是独立消耗，必须计入；流式分片按 message.id 去重
import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const SRC = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'csub-')); const HOME = path.join(T, 'home'); const SRV = path.join(T, 'server');
fs.cpSync(SRC, SRV, { recursive: true, filter: (p) => !/\/(\.cache|data|tools)(\/|$)/.test(p) });
fs.mkdirSync(path.join(SRV, '.cache'), { recursive: true }); process.env.HOME = HOME; process.env.AUB_MINI = 'off';
const proj = path.join(HOME, '.claude', 'projects', '-proj'); const sess = 'abc123';
fs.mkdirSync(path.join(proj, sess, 'subagents'), { recursive: true }); fs.mkdirSync(path.join(proj, sess, 'tool-results'), { recursive: true });
const today = new Date().toISOString();
const line = (id, model, i, o, r, w) => JSON.stringify({ type: 'assistant', timestamp: today, cwd: '/p', message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w } } });
fs.writeFileSync(path.join(proj, `${sess}.jsonl`), [line('m1', 'claude-opus-5-5', 10, 1, 100, 5), line('m1', 'claude-opus-5-5', 10, 1, 100, 5)].join('\n') + '\n'); // 流式分片重复 → 只算一次
fs.writeFileSync(path.join(proj, sess, 'subagents', 'agent-x.jsonl'), [line('s1', 'claude-haiku-5-5', 2, 3, 20, 0), line('s1', 'claude-haiku-5-5', 2, 3, 20, 0), line('s2', 'claude-haiku-5-5', 1, 1, 10, 0)].join('\n') + '\n');
fs.writeFileSync(path.join(proj, sess, 'tool-results', 'noise.jsonl'), line('t1', 'claude-opus-5-5', 999, 999, 999, 999) + '\n'); // 非 subagents 目录不算
const { createClaudeAdapter } = await import(path.join(SRV, 'adapters/claude.mjs'));
const rows = await createClaudeAdapter().usageRows();
const tot = (f) => rows.filter(f).reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
assert.equal(tot((r) => r.model === 'claude-opus-5-5'), 10 + 1 + 100 + 5, '主会话只算一次（分片去重），tool-results 不算');
assert.equal(tot((r) => r.model === 'claude-haiku-5-5'), (2 + 3 + 20) + (1 + 1 + 10), '子智能体日志计入，分片去重');
const again = await createClaudeAdapter().usageRows(); assert.equal(tot.call(null, () => true), again.reduce((s, r) => s + r.input + r.output + r.cacheRead + r.cacheWrite, 0), '再扫一遍不变');
fs.rmSync(T, { recursive: true, force: true });
console.log('Claude 子智能体日志测试通过: 子智能体计入/分片去重/tool-results 不算/重复扫描不变');
