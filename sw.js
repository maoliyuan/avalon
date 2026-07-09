/* 阿瓦隆记牌器 —— Service Worker
 * 更新应用后，把下面的 VERSION 改一下（如 v2、v3…），即可让所有设备拉到新版本。 */
const VERSION = 'v4';
const CACHE = 'avalon-tracker-' + VERSION;

const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 页面导航：优先缓存，失败回退到 index.html（保证离线能开）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then(c => c || fetch(req).catch(() => caches.match('index.html')))
    );
    return;
  }

  // 其它静态资源：缓存优先，缺失再联网并写入缓存
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
