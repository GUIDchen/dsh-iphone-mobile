// 推送服务端：订阅存储、VAPID 密钥、事件流观察与通知分发。
// 帧结构来自 dsh 的权威契约 @deepseek-ai/dsh-host-apiproxy 的 MuxFrame 联合类型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateVapidKeys, sendWebPush } from './webpush.mjs';

const DIR = path.join(os.homedir(), '.dsh-mobile');
const SUBS_FILE = path.join(DIR, 'subscriptions.json');
const VAPID_FILE = path.join(DIR, 'vapid.json');

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

export function loadOrCreateVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (raw.publicKey && raw.privateKey) return raw;
  } catch {
    /* 首次运行 */
  }
  ensureDir();
  const keys = generateVapidKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

export function readSubscriptions() {
  try {
    const list = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(list) {
  ensureDir();
  fs.writeFileSync(SUBS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

export function addSubscription(subscription, device) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('订阅格式不合法：需要 endpoint 与 keys.p256dh / keys.auth');
  }
  const list = readSubscriptions().filter((s) => s.endpoint !== subscription.endpoint);
  list.push({ ...subscription, device: device || 'unknown', addedAt: Date.now(), lastOkAt: null });
  writeSubscriptions(list);
  return list.length;
}

export function removeSubscription(endpoint) {
  const before = readSubscriptions();
  const after = before.filter((s) => s.endpoint !== endpoint);
  writeSubscriptions(after);
  return before.length - after.length;
}

/**
 * 把一帧 mux 事件映射成通知（纯函数，便于单测）。
 * @param frame 来自 /api/events.mux 的 payload 对象
 * @param state 跨帧状态，用于任务终态去重
 * @returns 通知数组，元素为 { title, body, url, tag, urgency }
 */
export function notificationsForFrame(frame, state) {
  const out = [];
  if (!frame || typeof frame !== 'object') return out;
  const session = frame.sessionId ? String(frame.sessionId).replace(/^session-/, '').slice(0, 8) : '';

  if (frame.type === 'approval/requested') {
    const reason = frame.reason ? ' · ' + frame.reason : '';
    out.push({
      title: '需要你的批准',
      body: (frame.toolName || '工具调用') + reason + (session ? '（会话 ' + session + '）' : ''),
      url: '/',
      tag: 'approval:' + (frame.approvalId || 'unknown'),
      urgency: 'high',
    });
    return out;
  }

  if (frame.type === 'question/requested') {
    const first = Array.isArray(frame.questions) && frame.questions.length > 0 ? frame.questions[0] : null;
    const text = first && (first.question || first.header) ? first.question || first.header : 'Harness 在等你回答';
    out.push({
      title: '需要你的回答',
      body: String(text).slice(0, 120) + (session ? '（会话 ' + session + '）' : ''),
      url: '/',
      tag: 'question:' + session,
      urgency: 'high',
    });
    return out;
  }

  if (frame.type === 'host/agent-error') {
    out.push({
      title: '任务失败',
      body: String(frame.message || 'agent 报错').slice(0, 120),
      url: '/',
      tag: 'error:' + session,
      urgency: 'high',
    });
    return out;
  }

  if (frame.type === 'session/jobs' && Array.isArray(frame.jobs)) {
    const prev = state.jobs || (state.jobs = new Map());
    for (const job of frame.jobs) {
      const key = frame.sessionId + ':' + job.id;
      const last = prev.get(key);
      const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'killed';
      if (terminal && last !== job.status) {
        const ok = job.status === 'completed';
        out.push({
          title: ok ? '任务完成' : '任务结束：' + job.status,
          body: (job.label || job.id).slice(0, 100) + (job.detail ? ' · ' + job.detail : ''),
          url: '/',
          tag: 'job:' + key,
          urgency: ok ? 'normal' : 'high',
        });
      }
      prev.set(key, job.status);
    }
    return out;
  }

  if (frame.type === 'session/event' && frame.event && frame.event.type === 'turn/end') {
    const prev = state.turns || (state.turns = new Set());
    const key = frame.sessionId + ':' + (frame.event.seq === undefined ? '' : frame.event.seq);
    if (!prev.has(key)) {
      prev.add(key);
      out.push({
        title: '一轮回答结束',
        body: session ? '会话 ' + session + ' 已完成本轮' : '本轮已完成',
        url: '/',
        tag: 'turn:' + key,
        urgency: 'normal',
      });
    }
    return out;
  }

  return out;
}

/** 把通知发给所有订阅，返回送达统计，并清理失效订阅。 */
export async function dispatch(notifications, options) {
  const opts = options || {};
  if (notifications.length === 0) return { sent: 0, pruned: 0 };
  const vapid = opts.vapid || loadOrCreateVapid();
  const subject = opts.subject || process.env.VAPID_SUBJECT || 'mailto:dsh-mobile@localhost';
  const subs = readSubscriptions();
  let sent = 0;
  let pruned = 0;
  for (const sub of subs) {
    for (const note of notifications) {
      let res;
      try {
        res = await sendWebPush(sub, { ...note }, vapid, subject, { urgency: note.urgency === 'high' ? 'high' : 'normal' });
      } catch (err) {
        console.warn('[push] 发送异常', err.message);
        continue;
      }
      if (res.gone) {
        removeSubscription(sub.endpoint);
        pruned += 1;
        break;
      }
      if (res.ok) sent += 1;
      else console.warn('[push] 发送失败 status=' + res.status);
    }
  }
  return { sent, pruned };
}

/**
 * 观察 dsh 事件流并分发通知。断线自动重连：契约说明服务端不支持 since 游标，
 * 重连即重开流（宿主会自动重放仍未处理的审批帧），因此这里只需指数退避重开。
 */
export function startEventWatcher(options) {
  const opts = options || {};
  const port = opts.port || process.env.DSH_PORT || 3080;
  const url = 'ws://127.0.0.1:' + port + '/api/events.mux';
  const state = { jobs: new Map(), turns: new Set() };
  let retry = 0;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      retry = 0;
      if (opts.onStatus) opts.onStatus('open');
    });
    ws.addEventListener('message', (ev) => {
      let envelope;
      try {
        envelope = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (!envelope || envelope.type !== 'server-request') return;
      const frame = envelope.payload;
      const notes = notificationsForFrame(frame, state);
      if (notes.length === 0) return;
      dispatch(notes, opts).catch((err) => console.warn('[push] 分发异常', err.message));
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      const delay = Math.min(30000, 500 * 2 ** retry);
      retry += 1;
      if (opts.onStatus) opts.onStatus('closed, retry in ' + delay + 'ms');
      setTimeout(connect, delay);
    });
    ws.addEventListener('error', () => {
      /* close 事件会跟着触发，统一在那里退避 */
    });
  };

  connect();
  return { stop: () => { closed = true; } };
}
