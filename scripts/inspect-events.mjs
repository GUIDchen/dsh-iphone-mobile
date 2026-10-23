#!/usr/bin/env node
// 观察 dsh 事件流的真实帧结构：连上 mux/host 下行流，打印前若干帧。
// 用法：node scripts/inspect-events.mjs [秒数] [路径，默认 /api/events.mux]
import { setTimeout as sleep } from 'node:timers/promises';

const seconds = Number(process.argv[2] || 8);
const pathname = process.argv[3] || '/api/events.mux';
const url = 'ws://127.0.0.1:' + (process.env.DSH_PORT || 3080) + pathname;

console.log('连接', url, '观察', seconds, '秒');
const ws = new WebSocket(url);
let n = 0;

ws.addEventListener('open', () => console.log('已打开'));
ws.addEventListener('error', (e) => console.log('错误', e.message || e.type));
ws.addEventListener('message', (ev) => {
  n += 1;
  const text = typeof ev.data === 'string' ? ev.data : '[binary]';
  if (n <= 12) {
    console.log('--- frame', n, 'len', text.length);
    console.log(text.slice(0, 600));
  }
});

await sleep(seconds * 1000);
console.log('共收到帧数:', n);
ws.close();
process.exit(0);
