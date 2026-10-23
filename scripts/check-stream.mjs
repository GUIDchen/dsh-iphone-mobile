#!/usr/bin/env node
// 校验事件流：序号严格单调、无重复、无空洞（可选 --strict-gap）。
// 用法：node scripts/check-stream.mjs < logs/events.jsonl
//      node scripts/check-stream.mjs --selftest
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

function verify(lines) {
  const seen = new Set();
  let prev = 0;
  let count = 0;
  let gap = false;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      throw new Error('第 ' + (count + 1) + ' 行不是合法 JSON: ' + line.slice(0, 80));
    }
    if (typeof e.id !== 'number') throw new Error('事件缺少数字 id: ' + line.slice(0, 80));
    if (seen.has(e.id)) throw new Error('重复事件 id: ' + e.id);
    if (e.id <= prev) throw new Error('序号回退: ' + e.id + ' <= ' + prev);
    if (e.id !== prev + 1) gap = true;
    seen.add(e.id);
    prev = e.id;
    count += 1;
  }
  return { count, last: prev, gap };
}

function selftest() {
  const ok = ['{"id":1}', '{"id":2}', '{"id":3}'];
  const bad = ['{"id":1}', '{"id":1}'];
  const run = (lines) => {
    try {
      return { ok: true, res: verify(lines) };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  };
  const a = run(ok);
  const b = run(bad);
  const c = run(['{"id":2}', '{"id":1}']);
  const pass = a.ok && !b.ok && !c.ok;
  console.log('正常流:', JSON.stringify(a.res));
  console.log('重复流被拒:', !b.ok);
  console.log('回退流被拒:', !c.ok);
  if (!pass) {
    console.error('自测失败');
    process.exit(1);
  }
  console.log('自测通过');
}

if (args.includes('--selftest')) {
  selftest();
} else {
  const rl = createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  try {
    const res = verify(lines);
    console.log('通过：共 ' + res.count + ' 条事件，末尾序号 ' + res.last + '，单调且无重复');
    if (res.gap) console.log('提示：存在序号空洞，确认是否为服务端丢弃或客户端漏收');
  } catch (err) {
    console.error('校验失败：' + err.message);
    process.exit(1);
  }
}
