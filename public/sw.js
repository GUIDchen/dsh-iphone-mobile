/* DSH Mobile service worker。
   ponytail: 不做页面缓存——GUI 内容随会话变化，缓存只会带来陈旧与难查的 bug。
   这里只承担推送接收与通知点击跳转。离线壳等出现真实需求再加。 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'DSH', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'DSH Mobile', {
      body: data.body || '',
      tag: data.tag || 'dsh',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf(target) >= 0 && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
