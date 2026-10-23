// 注入的推送入口：未订阅时一键开启，已订阅时作为状态页入口。
// iOS 要求订阅必须发生在用户手势中，所以这里始终是按钮而不是自动订阅。
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

(async function mountPushControl() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch {
    return;
  }

  const permissionDenied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  let subscription = null;
  try {
    subscription = await reg.pushManager.getSubscription();
  } catch {
    subscription = null;
  }
  if (!subscription && permissionDenied) return; // 已被拒绝且未订阅，不再打扰

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText =
    'position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483647;' +
    'padding:10px 16px;border-radius:999px;border:1px solid rgba(127,127,127,.45);' +
    'background:rgba(24,24,27,.92);color:#fff;font-size:14px;line-height:1';
  btn.textContent = subscription ? '通知已开' : '开启通知';

  btn.addEventListener('click', async () => {
    if (subscription) {
      location.href = '/m/status';
      return;
    }
    btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        location.href = '/m/status';
        return;
      }
      const info = await fetch('/m/push/vapid').then((r) => r.json());
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(info.publicKey),
      });
      await fetch('/m/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), device: navigator.userAgent }),
      });
      subscription = sub;
      btn.textContent = '通知已开';
    } catch (err) {
      console.warn('[dsh-mobile] 订阅推送失败', err);
      location.href = '/m/status';
    } finally {
      btn.disabled = false;
    }
  });

  document.body.appendChild(btn);
})();
