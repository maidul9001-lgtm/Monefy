const CACHE_NAME = 'hisaber-khata-v4';
const APP_SHELL = [
  'index.html',
  'daily_expense.html',
  'bank_account.html',
  'monthly_summary.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'api/sync-client.js',
  'logo/Islamic.png',
  'logo/agrani.png',
  'logo/bKash.png',
  'logo/celfin.png',
  'logo/main_balance.png',
  'logo/nagad.png',
  'logo/pubali.jpg',
  'logo/rocket.png'
];

self.addEventListener('install', (event) => {
  // addAll একটা ফাইল ব্যর্থ হলে সবই বাতিল হয় — তাই প্রতিটা আলাদাভাবে ক্যাশ করা হচ্ছে
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((path) => cache.add(path)))
    ).catch(() => {})
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

function putInCache(req, res) {
  if (res && res.ok) {
    const clone = res.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
  }
}

// HTML/JS/JSON: আগে নেটওয়ার্ক (সবসময় সর্বশেষ কোড), ধীর/অফলাইন হলে ক্যাশ।
// এতে HTML আর sync-client.js কখনো আলাদা ভার্সনের হয়ে মিসম্যাচ করে না।
function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const fallback = () =>
      caches.match(req, { ignoreSearch: true }).then((c) =>
        c || (req.mode === 'navigate' ? caches.match('index.html') : undefined)
      );
    const timer = setTimeout(() => {
      fallback().then((c) => { if (c && !done) { done = true; resolve(c); } });
    }, 4000);
    fetch(req)
      .then((res) => {
        clearTimeout(timer);
        putInCache(req, res);
        if (!done) { done = true; resolve(res); }
      })
      .catch(() => {
        clearTimeout(timer);
        fallback().then((c) => { if (!done) { done = true; resolve(c || Response.error()); } });
      });
  });
}

// ছবি ইত্যাদি: ক্যাশ-ফার্স্ট, পেছনে নতুন করে আনা হয়।
function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    const fetchPromise = fetch(req)
      .then((res) => { putInCache(req, res); return res; })
      .catch(() => cached);
    return cached || fetchPromise;
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Firebase SDK (gstatic.com/firebasejs/<ভার্সন>/...) — ভার্সন-নির্দিষ্ট, অপরিবর্তনীয় ফাইল।
  // এটা ক্যাশ না থাকলে অফলাইনে অ্যাপ খুললে sync চালু হতে পারে না।
  // (Firestore/Auth-এর ডাটা রিকোয়েস্ট এখানে নেই — সেগুলো সরাসরি নেটওয়ার্কে যায়, কখনো ক্যাশ হয় না।)
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => { putInCache(req, res); return res; })
      )
    );
    return;
  }

  // বাকি সব cross-origin রিকোয়েস্ট সরাসরি নেটওয়ার্কে।
  if (url.origin !== self.location.origin) return;

  const isCode = req.mode === 'navigate' ||
    /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  event.respondWith(isCode ? networkFirst(req) : cacheFirst(req));
});
