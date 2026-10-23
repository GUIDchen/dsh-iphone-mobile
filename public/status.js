// 状态页逻辑：探测上游、显示订阅数、手势内订阅、发送测试通知。
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

const msg = (text) => {
  const el = document.getElementById('msg');
  if (el) el.textContent = text;
};

async function refresh() {
  try {
    const up = await fetch('/m/push/status').then((r) => r.json());
    document.getElementById('subs').textContent = up.count + ' 台设备';
  } catch {
    document.getElementById('subs').textContent = '读取失败';
  }
  try {
    const res = await fetch('/m/health').then((r) => r.json());
    document.getElementById('upstream').textContent = res.upstream
      ? '可达（HTTP ' + res.upstreamStatus + '）'
      : '不可达（' + (res.upstreamError || '未知原因') + '）';
  } catch {
    document.getElementById('upstream').textContent = '检测失败';
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  const btn = document.getElementById('enable');
  if (!supported) {
    btn.textContent = '此浏览器不支持 Web Push';
    btn.disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  btn.textContent = sub ? '通知已开启（点击重新同步）' : '开启通知';
}

document.getElementById('enable').addEventListener('click', async () => {
  const btn = document.getElementById('enable');
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      msg('系统通知权限被拒绝，请到 iOS 设置里允许');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const info = await fetch('/m/push/vapid').then((r) => r.json());
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(info.publicKey),
      });
    }
    await fetch('/m/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), device: navigator.userAgent }),
    });
    msg('订阅已登记');
  } catch (err) {
    msg('订阅失败：' + err.message);
  } finally {
    btn.disabled = false;
    refresh();
  }
});

document.getElementById('test').addEventListener('click', async () => {
  msg('发送中…');
  try {
    const res = await fetch('/m/push/test', { method: 'POST' }).then((r) => r.json());
    msg('已尝试 ' + res.attempted + ' 台，成功 ' + res.sent + ' 台');
  } catch (err) {
    msg('发送失败：' + err.message);
  }
});

refresh();
