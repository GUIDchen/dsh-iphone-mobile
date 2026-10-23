#!/usr/bin/env node
// Web Push 发送端自测：本地起一个假推送服务，用真实密钥往返验证加密与 VAPID 签名。
// 用法：node scripts/selftest-webpush.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { generateVapidKeys, encryptPayload, decryptPayload, vapidHeader, sendWebPush } from '../server/webpush.mjs';

let failed = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : ' -> ' + extra));
  if (!ok) failed += 1;
}

// 1) 订阅端（等价浏览器）：自己的 P-256 密钥对 + 16 字节 auth secret
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const vapid = generateVapidKeys();
const subject = 'mailto:test@example.com';

let received = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = { headers: req.headers, body: Buffer.concat(chunks), url: req.url };
    res.writeHead(201).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const endpoint = 'http://127.0.0.1:' + port + '/push/abc';

const subscription = {
  endpoint,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
};

const payload = { title: '需要你的批准', body: 'Bash: pnpm test', url: '/chat/s1', tag: 'approve' };
const result = await sendWebPush(subscription, payload, vapid, subject);

check('发送返回成功', result.ok === true, result.status);
check('使用 aes128gcm 编码', received.headers['content-encoding'] === 'aes128gcm');
check('携带 TTL', String(received.headers.ttl) === '3600');

const auth = String(received.headers.authorization || '');
check('Authorization 是 vapid 方案', auth.startsWith('vapid t='));
const jwt = auth.slice('vapid t='.length).split(',')[0];
const parts = jwt.split('.');
const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
check('JWT aud 等于端点 origin', decoded.aud === 'http://127.0.0.1:' + port, decoded.aud);
check('JWT sub 正确', decoded.sub === subject);

const pub = Buffer.from(vapid.publicKey, 'base64url');
const vkey = crypto.createPublicKey({
  key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
  format: 'jwk',
});
const sigOk = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1], 'utf8'), { key: vkey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
check('VAPID JWT 签名可验证', sigOk === true);

const plain = decryptPayload(received.body, ua, subscription.keys.auth);
let roundTrip = null;
try {
  roundTrip = JSON.parse(plain);
} catch (err) {
  roundTrip = null;
}
check('密文可用订阅端私钥解出', roundTrip !== null);
check('解出的负载与原文一致', roundTrip && roundTrip.title === payload.title && roundTrip.url === payload.url, plain.slice(0, 80));

// 2) 失效订阅（410）应被识别为需要清理
const dead = http.createServer((req, res) => res.writeHead(410).end());
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const deadRes = await sendWebPush({ endpoint: 'http://127.0.0.1:' + dead.address().port + '/x', keys: subscription.keys }, { title: 'x' }, vapid, subject);
check('410 被识别为订阅失效', deadRes.gone === true, deadRes.status);

// 3) 篡改密文应解密失败（GCM 完整性）
const body = encryptPayload(subscription, '{"a":1}');
body[body.length - 20] ^= 0xff;
let tamperThrew = false;
try {
  decryptPayload(body, ua, subscription.keys.auth);
} catch {
  tamperThrew = true;
}
check('篡改密文解密失败（完整性生效）', tamperThrew === true);

server.close();
dead.close();
console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
