const CACHE_NAME = 'hisaber-khata-v3';
const APP_SHELL = [
  'index.html',
  'daily_expense.html',
  'bank_account.html',
  'monthly_summary.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'api/sync-client.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // এই অ্যাপের cloud sync সরাসরি Firebase (Firestore/Auth) ব্যবহার করে, কোনো
  // /api/auth.php বা /api/sync.php এন্ডপয়েন্ট নেই। তাই নিরাপদ থাকার জন্য এই
  // service worker শুধু নিজের origin-এর (same-origin) অ্যাপ-শেল রিকোয়েস্ট
  // handle করবে — Firebase/Firestore-সহ অন্য যেকোনো cross-origin রিকোয়েস্ট
  // সরাসরি নেটওয়ার্কে চলে যাবে, যাতে sync পুল কখনও ভুলবশত পুরনো cache করা
  // ডাটা ফেরত না দেয়।
  if (url.origin !== self.location.origin) return;

  // App shell & other same-origin assets: cache-first, refresh cache in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
