/* =========================================================
 * sw.js — Service Worker (Offline + Performance)
 * - Cache-first (SWR) untuk assets same-origin
 * - TIDAK mencegat request cross-origin (Apps Script & CDN)
 * ========================================================= */
const SW_VERSION   = 'tsh-erp-v6';          // bump version to update clients
const ASSET_CACHE  = `${SW_VERSION}-assets`;
const API_CACHE    = `${SW_VERSION}-api`;   // reserved (tidak dipakai skrg)

// Samakan versi dengan yang di index.html ?v=...
const APP_JS_VERSION = '2025-10-21-03-2'; // <-- ganti angka/akhiran

// Precache hanya aset same-origin yang pasti ada
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  `./app.js?v=${APP_JS_VERSION}`,
  './assets/tsh.png',
  // Catatan: JANGAN masukkan CDN/cross-origin ke sini
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(ASSET_CACHE)
      .then(cache => cache.addAll(CORE_ASSETS))
      .catch(() => {}) // abaikan error opaque, dll.
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => ![ASSET_CACHE, API_CACHE].includes(k))
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// HANYA tangani request same-origin + GET (static assets)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Biarkan SEMUA cross-origin langsung ke network (Apps Script JSONP, CDN, dll)
  if (url.origin !== self.location.origin) return;

  // Hanya GET yang dicache
  if (req.method !== 'GET') return;

  // Stale-While-Revalidate untuk assets same-origin
  e.respondWith((async () => {
    const cache  = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);

    const fetchPromise = fetch(req).then(net => {
      cache.put(req, net.clone());
      return net;
    }).catch(() => {
      if (cached) return cached;
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    });

    return cached || fetchPromise;
  })());
});
