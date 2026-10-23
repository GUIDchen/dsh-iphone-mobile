#!/usr/bin/env node
// 网关自测：对着正在运行的 gateway 逐条断言，失败即非零退出。
// 用法：node scripts/selftest-gateway.mjs   （需要 gateway 已在 127.0.0.1:3081 运行）
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { decryptPayload } from '../server/webpush.mjs';

const BASE_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.GATEWAY_PORT || 3081);
const TOKEN = process.env.GATEWAY_TOKEN || fs.readFileSync(path.join(os.homedir(), '.dsh-mobile', 'token'), 'utf8').trim();

let failed = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : ' -> ' + extra));
  if (!ok) failed += 1;
}

async function head(pathname, headers) {
  const res = await fetch('http://' + BASE_HOST + ':' + BASE_PORT + pathname, {
    headers: headers || {},
    redirect: 'manual',
  });
  return res;
}

function upgradeStatus(pathname, withCookie) {
  return new Promise((resolve) => {
    const socket = net.connect(BASE_PORT, BASE_HOST, () => {
      const lines = [
        'GET ' + pathname + ' HTTP/1.1',
        'Host: dsh.example.com',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      if (withCookie) lines.push('Cookie: dsh_mobile_token=' + TOKEN);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.indexOf('\r\n') >= 0) done(buf.split('\r\n')[0]);
    });
    socket.on('error', () => done('SOCKET_ERROR'));
    setTimeout(() => done('TIMEOUT'), 5000);
  });
}

const unauth = await head('/');
check('未认证返回 401', unauth.status === 401, unauth.status);

const badLogin = await head('/login?token=wrong');
check('错误令牌仍 401', badLogin.status === 401, badLogin.status);

const goodLogin = await head('/login?token=' + TOKEN);
const cookie = String(goodLogin.headers.get('set-cookie') || '');
check('正确令牌 302 并下发 Cookie', goodLogin.status === 302 && cookie.includes('dsh_mobile_token='), goodLogin.status);

// 隧道场景下必须带上 Secure
const secureLogin = await head('/login?token=' + TOKEN, { 'x-forwarded-proto': 'https' });
const secureCookie = String(secureLogin.headers.get('set-cookie') || '');
check('HTTPS 来源下 Cookie 加 Secure', secureCookie.includes('; Secure'), secureCookie.replace(/dsh_mobile_token=[^;]+/, 'dsh_mobile_token=***'));

// 限流：连续错误令牌后出现 429，且正确令牌仍能进入（不锁主人）
let throttled = 0;
for (let i = 0; i < 6; i += 1) {
  const r = await head('/login?token=wrong-' + i);
  if (r.status === 429) throttled += 1;
}
check('连续错误令牌被限流', throttled > 0, throttled + ' 次 429');
const afterThrottle = await head('/login?token=' + TOKEN);
check('限流不影响正确令牌（不锁主人）', afterThrottle.status === 302, afterThrottle.status);

const authed = await head('/', { Host: 'dsh.example.com', Cookie: 'dsh_mobile_token=' + TOKEN });
const html = await authed.text();
check('伪装隧道域名仍取到页面（围栏由网关代过）', authed.status === 200, authed.status);
check('注入 manifest', html.includes('manifest.webmanifest'));
check('注入移动端样式', html.includes('/m/mobile.css'));
check('注入 Service Worker 注册', html.includes('/m/register.js'));

const manifest = await head('/m/manifest.webmanifest');
check('manifest 可读', manifest.status === 200 && String(manifest.headers.get('content-type')).includes('manifest'), manifest.status);

const icon = await head('/m/icons/icon-180.png');
check('图标可读', icon.status === 200, icon.status);

const swRes = await head('/m/sw.js');
check('Service Worker 放宽作用域到根（否则 ready 永不 resolve）',
  String(swRes.headers.get('service-worker-allowed') || '') === '/',
  swRes.headers.get('service-worker-allowed'));

const traversalRaw = await new Promise((resolve) => {
  const socket = net.connect(BASE_PORT, BASE_HOST, () => {
    socket.write('GET /m/../package.json HTTP/1.1\r\nHost: x\r\nCookie: dsh_mobile_token=' + TOKEN + '\r\n\r\n');
  });
  let buf = '';
  socket.on('data', (d) => {
    buf += d.toString('latin1');
    if (buf.indexOf('\r\n') >= 0) {
      socket.destroy();
      resolve(buf.split('\r\n')[0]);
    }
  });
  socket.on('error', () => resolve('SOCKET_ERROR'));
  setTimeout(() => resolve('TIMEOUT'), 5000);
});
check('目录穿越被拒', /40[0-9]|404/.test(traversalRaw), traversalRaw);

const wsNoAuth = await upgradeStatus('/api/events.mux', false);
check('未认证 WebSocket 被拒', wsNoAuth.indexOf('401') >= 0, wsNoAuth);

const wsAuth = await upgradeStatus('/api/events.mux', true);
check('认证后 WebSocket 升级成功', wsAuth.indexOf('101') >= 0, wsAuth);

const hostWs = await upgradeStatus('/api/events.host', true);
check('events.host 升级成功', hostWs.indexOf('101') >= 0, hostWs);

// --- 推送链路：订阅 -> 服务端测试推送 -> 假推送服务解密验证 ---
const unauthPush = await head('/m/push/vapid');
check('未认证访问推送端点被拒', unauthPush.status === 401, unauthPush.status);

const unauthStatus = await head('/m/status');
check('未认证访问状态页被拒', unauthStatus.status === 401, unauthStatus.status);

const statusRes = await head('/m/status', { Cookie: 'dsh_mobile_token=' + TOKEN });
const statusHtml = await statusRes.text();
check('状态页可打开', statusRes.status === 200, statusRes.status);
check('状态页含订阅与测试入口', statusHtml.includes('开启通知') && statusHtml.includes('发送测试通知'));

const health = await head('/m/health', { Cookie: 'dsh_mobile_token=' + TOKEN });
const healthBody = await health.json();
check('健康检查报告上游可达', health.status === 200 && healthBody.upstream === true, JSON.stringify(healthBody));

let captured = null;
const fakePush = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    captured = { body: Buffer.concat(chunks), headers: req.headers };
    res.writeHead(201).end();
  });
});
await new Promise((r) => fakePush.listen(0, '127.0.0.1', r));
const fakePort = fakePush.address().port;

// 订阅端等价物：浏览器会自己生成这对密钥
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const endpoint = 'http://127.0.0.1:' + fakePort + '/push/verify';

const subscribeRes = await fetch('http://' + BASE_HOST + ':' + BASE_PORT + '/m/push/subscribe', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Cookie: 'dsh_mobile_token=' + TOKEN },
  body: JSON.stringify({
    subscription: { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } },
    device: 'selftest',
  }),
});
const subscribeBody = await subscribeRes.json();
check('订阅登记成功', subscribeRes.status === 200 && subscribeBody.count >= 1, JSON.stringify(subscribeBody));

const vapidRes = await fetch('http://' + BASE_HOST + ':' + BASE_PORT + '/m/push/vapid', {
  headers: { Cookie: 'dsh_mobile_token=' + TOKEN },
});
const vapidBody = await vapidRes.json();
check('可取到 VAPID 公钥', vapidRes.status === 200 && typeof vapidBody.publicKey === 'string' && vapidBody.publicKey.length > 40, vapidBody.publicKey ? vapidBody.publicKey.slice(0, 12) + '...' : 'none');

const testRes = await fetch('http://' + BASE_HOST + ':' + BASE_PORT + '/m/push/test', {
  method: 'POST',
  headers: { Cookie: 'dsh_mobile_token=' + TOKEN },
});
const testBody = await testRes.json();
check('测试推送送达订阅端', testBody.attempted >= 1 && testBody.sent >= 1, JSON.stringify(testBody));
check('假推送服务确实收到请求', captured !== null && String(captured.headers['content-encoding']) === 'aes128gcm');

let delivered = null;
if (captured) {
  try {
    delivered = JSON.parse(decryptPayload(captured.body, ua, authSecret.toString('base64url')));
  } catch (err) {
    delivered = { error: err.message };
  }
}
check('网关发出的密文可被订阅端解密', delivered && delivered.title === 'DSH Mobile 测试通知', JSON.stringify(delivered).slice(0, 120));

const unsubRes = await fetch('http://' + BASE_HOST + ':' + BASE_PORT + '/m/push/unsubscribe', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Cookie: 'dsh_mobile_token=' + TOKEN },
  body: JSON.stringify({ endpoint }),
});
const unsubBody = await unsubRes.json();
check('退订生效', unsubRes.status === 200 && unsubBody.removed === 1, JSON.stringify(unsubBody));

fakePush.close();

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
