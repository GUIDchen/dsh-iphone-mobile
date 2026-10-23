/* 注册 Service Worker 并把订阅入口暴露到 window，等推送服务端就绪后复用。 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/m/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[dsh-mobile] service worker 注册失败', err);
    });
  });
}
