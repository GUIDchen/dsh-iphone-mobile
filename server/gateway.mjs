#!/usr/bin/env node
// dsh-mobile-gateway：把本机 dsh web 安全地暴露给手机，并叠加移动端 PWA 层。
// 零依赖：node:http + node:net 直通代理，HTTP 与 WebSocket upgrade 走同一条路径。
//
// 为什么需要它：dsh web 的 /api 有浏览器信任围栏，只接受 loopback 或 --trusted-host 声明的
// Host。本网关把上游请求的 Host 重写为 loopback、去掉 Origin，围栏因此无需改动即可通过；
// 对外则由本网关自己的令牌把关，隧道后面不再是一扇开着的门。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadOrCreateVapid, addSubscription, removeSubscription, readSubscriptions, dispatch, startEventWatcher } from './push.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.DSH_PORT || 3080);
const LISTEN_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.GATEWAY_PORT || 3081);
const COOKIE = 'dsh_mobile_token';
const PUBLIC_PREFIX = '/m/';

function loadToken() {
  if (process.env.GATEWAY_TOKEN) return process.env.GATEWAY_TOKEN;
  const dir = path.join(os.homedir(), '.dsh-mobile');
  const file = path.join(dir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 首次运行，下面生成 */
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

const TOKEN = loadToken();

function constantEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// 登录失败限流。只拖慢暴力尝试，绝不锁住持有正确令牌的主人：
// 令牌正确一律放行并清零计数，只有连续失败的来源才会被挡。
const LOGIN_MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES || 5);
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 60000);
const loginFailures = new Map();

function recordLoginFailure(ip) {
  const now = Date.now();
  for (const [key, rec] of loginFailures) {
    if (now - rec.last > LOGIN_LOCK_MS * 4) loginFailures.delete(key);
  }
  const rec = loginFailures.get(ip) || { count: 0, last: now, until: 0 };
  rec.count += 1;
  rec.last = now;
  rec.blocked = rec.count >= LOGIN_MAX_FAILURES;
  if (rec.blocked) rec.until = now + LOGIN_LOCK_MS;
  loginFailures.set(ip, rec);
  return rec;
}

/** 隧道终止 TLS 时浏览器到网关这段是明文，用 x-forwarded-proto 判断是否该加 Secure。 */
function cookieHeader(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = proto === 'https' || req.socket.encrypted === true;
  return (
    COOKIE + '=' + encodeURIComponent(TOKEN) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (secure ? '; Secure' : '')
  );
}

function cookiesOf(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const c = cookiesOf(req);
  if (c[COOKIE] && constantEq(c[COOKIE], TOKEN)) return true;
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('token');
  return Boolean(q && constantEq(q, TOKEN));
}

function loginPage(bad) {
  const hint = bad ? '<p class="bad">令牌不正确</p>' : '';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>DSH Mobile</title><style>' +
    'body{font:16px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:520px}' +
    'input{width:100%;padding:12px;font-size:16px;box-sizing:border-box;margin:8px 0}' +
    'button{width:100%;padding:12px;font-size:16px}' +
    '.hint{font-size:13px;opacity:.7;word-break:break-all}' +
    '.bad{color:#c00}' +
    '</style></head><body><h2>DSH Mobile</h2>' + hint +
    '<p class="hint">输入访问令牌。令牌在本机生成，可用 cat ~/.dsh-mobile/token 查看。</p>' +
    '<form method="GET" action="/login"><input name="token" placeholder="访问令牌" autocomplete="off">' +
    '<button type="submit">进入</button></form></body></html>';
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
};

function servePublic(req, res, pathname) {
  const rel = pathname.slice(PUBLIC_PREFIX.length) || 'index.html';
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  const headers = {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  };
  // Service Worker 必须能控制根路径：脚本在 /m/ 下，靠这个响应头放宽作用域，
  // 否则 navigator.serviceWorker.ready 在 / 页面上永不 resolve，推送入口也就永远不会出现。
  if (rel === 'sw.js') headers['service-worker-allowed'] = '/';
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

// 注入移动端 PWA 能力。ponytail: 只做注入，不改 dsh 自身的产物；
// 若 dsh 的 index 结构变化，这里靠 </head> 锚点仍然稳定。
function injectMobile(html) {
  const head = [
    '<link rel="manifest" href="/m/manifest.webmanifest">',
    '<script src="/m/push-client.js" defer></script>',
    '<link rel="stylesheet" href="/m/mobile.css">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="apple-mobile-web-app-title" content="DSH Mobile">',
    '<link rel="apple-touch-icon" href="/m/icons/icon-180.png">',
    '<script src="/m/register.js" defer></script>',
  ].join('');
  if (html.includes('</head>')) return html.replace('</head>', head + '</head>');
  return head + html;
}

let watcherStatus = '未启动（PUSH_DISABLED=1）';


function statusPageHtml(watcherStatus) {
  const body = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<link rel="manifest" href="/m/manifest.webmanifest">',
    '<title>DSH Mobile 状态</title><style>',
    'body{font:16px/1.7 -apple-system,system-ui,sans-serif;margin:0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));max-width:560px}',
    'h2{margin:0 0 16px}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 20px}',
    'dt{opacity:.65}dd{margin:0;font-weight:600}',
    'button{width:100%;padding:14px;font-size:16px;margin-bottom:10px;border-radius:12px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit}',
    'a.btn{display:block;text-align:center;text-decoration:none}',
    '.muted{opacity:.6;font-size:13px}',
    '</style></head><body>',
    '<h2>DSH Mobile</h2><dl id="facts">',
    '<dt>网关</dt><dd>在线</dd>',
    '<dt>事件流观察器</dt><dd id="watcher">' + watcherStatus + '</dd>',
    '<dt>上游 dsh web</dt><dd id="upstream">检测中…</dd>',
    '<dt>推送订阅</dt><dd id="subs">检测中…</dd>',
    '</dl>',
    '<button id="enable" type="button">开启通知</button>',
    '<button id="test" type="button">发送测试通知</button>',
    '<a class="btn" href="/" style="padding:14px;border:1px solid rgba(127,127,127,.4);border-radius:12px">返回应用</a>',
    '<p class="muted" id="msg"></p>',
    '<script src="/m/status.js"></script>',
    '</body></html>',
  ].join('');
  return body;
}

async function upstreamHealth() {
  try {
    const res = await fetch('http://' + UPSTREAM_HOST + ':' + UPSTREAM_PORT + '/', {
      method: 'GET',
      signal: AbortSignal.timeout(2500),
    });
    return { upstream: true, upstreamStatus: res.status };
  } catch (err) {
    return { upstream: false, upstreamError: err.message };
  }
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handlePushApi(req, res, pathname) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  try {
    if (pathname === '/m/status' && req.method === 'GET') {
      const html = Buffer.from(statusPageHtml(watcherStatus), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(html.length), 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (pathname === '/m/health' && req.method === 'GET') {
      return sendJson(res, 200, await upstreamHealth());
    }
    if (pathname === '/m/push/vapid' && req.method === 'GET') {
      return sendJson(res, 200, { publicKey: loadOrCreateVapid().publicKey });
    }
    if (pathname === '/m/push/status' && req.method === 'GET') {
      return sendJson(res, 200, { count: readSubscriptions().length });
    }
    if (pathname === '/m/push/subscribe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, count: addSubscription(body.subscription, body.device) });
    }
    if (pathname === '/m/push/unsubscribe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { removed: removeSubscription(body.endpoint) });
    }
    if (pathname === '/m/push/test' && req.method === 'POST') {
      const attempted = readSubscriptions().length;
      const result = await dispatch(
        [{ title: 'DSH Mobile 测试通知', body: '看到这条说明推送链路是通的', url: '/', tag: 'test', urgency: 'normal' }],
        {},
      );
      return sendJson(res, 200, { ok: true, attempted, sent: result.sent, pruned: result.pruned });
    }
    return sendJson(res, 404, { error: '未知的推送端点' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
}

function proxyHttp(req, res) {
  const headers = { ...req.headers };
  headers.host = UPSTREAM_HOST + ':' + UPSTREAM_PORT;
  delete headers.origin;
  delete headers.referer;
  delete headers['sec-fetch-site'];
  headers['accept-encoding'] = 'identity';

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      const type = String(up.headers['content-type'] || '');
      if (!type.includes('text/html')) {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const html = injectMobile(Buffer.concat(chunks).toString('utf8'));
        const buf = Buffer.from(html, 'utf8');
        const out = { ...up.headers };
        // 上游是 chunked；改写 HTML 后必须改成定长，两者不能同时出现
        delete out['transfer-encoding'];
        out['content-length'] = String(buf.length);
        res.writeHead(up.statusCode || 200, out);
        res.end(buf);
      });
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('上游 dsh web 不可达：' + err.message + '（确认 dsh web 在 127.0.0.1:' + UPSTREAM_PORT + ' 运行）');
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // 推送端点必须先于公共静态分支：静态资源可匿名读，推送操作不可
  if (pathname.startsWith('/m/push/') || pathname === '/m/status' || pathname === '/m/health') {
    handlePushApi(req, res, pathname);
    return;
  }

  if (pathname.startsWith(PUBLIC_PREFIX)) {
    if (servePublic(req, res, pathname)) return;
  }

  if (pathname === '/login') {
    const token = url.searchParams.get('token') || '';
    if (constantEq(token, TOKEN)) {
      loginFailures.delete(req.socket.remoteAddress || 'unknown');
      res.writeHead(302, { 'set-cookie': cookieHeader(req), location: '/' });
      res.end();
      return;
    }
    const rec = recordLoginFailure(req.socket.remoteAddress || 'unknown');
    if (rec.blocked && rec.until > Date.now()) {
      res.writeHead(429, {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': String(Math.ceil((rec.until - Date.now()) / 1000)),
      });
      res.end(loginPage(true) + '<!-- 失败次数过多，已临时限流 -->');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(loginPage(true));
    return;
  }

  if (!isAuthed(req)) {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(loginPage(false));
    return;
  }

  proxyHttp(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!isAuthed(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const headers = { ...req.headers };
    headers.host = UPSTREAM_HOST + ':' + UPSTREAM_PORT;
    delete headers.origin;
    delete headers['sec-fetch-site'];
    const lines = ['GET ' + req.url + ' HTTP/1.1'];
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(k + ': ' + vv);
      else lines.push(k + ': ' + v);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log('DSH Mobile gateway 监听 http://' + LISTEN_HOST + ':' + LISTEN_PORT);
  console.log('上游 dsh web：http://' + UPSTREAM_HOST + ':' + UPSTREAM_PORT);
  console.log('令牌文件：~/.dsh-mobile/token（也可用 GATEWAY_TOKEN 覆盖）');
  console.log('手机访问：在入口地址后加 /login?token=<令牌> 一次即可换取 Cookie');
  if (process.env.PUSH_DISABLED !== '1') {
    startEventWatcher({
      onStatus: (s) => {
        watcherStatus = s;
        console.log('事件流观察器：' + s);
      },
    });
  } else {
    console.log('事件流观察器：已按 PUSH_DISABLED=1 关闭');
  }
});
