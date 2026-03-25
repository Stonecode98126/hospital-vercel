// Service Worker - 804桃園國軍總醫院看診提醒
const CACHE_NAME = 'hospital-v1';

// 安裝時快取主要資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(['/', '/index.html']))
  );
  self.skipWaiting();
});

// 啟動時清除舊快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 網路請求：優先網路，失敗則用快取
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── 收到推播通知 ──
self.addEventListener('push', (event) => {
  let data = { title: '看診提醒', body: '快輪到你了！', urgent: false };
  try { data = event.data.json(); } catch {}

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'queue-alert',          // 同 tag 的通知會覆蓋，不會疊加
    renotify: true,              // 即使同 tag 也要再震動
    requireInteraction: data.urgent,  // 緊急時通知不自動消失
    vibrate: data.urgent ? [500, 200, 500, 200, 500] : [300, 100, 300],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: '前往診間' },
      { action: 'dismiss', title: '知道了' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── 點擊通知 ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        clientList[0].focus();
      } else {
        clients.openWindow('/');
      }
    })
  );
});
