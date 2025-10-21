/* =========================================================
 * sw.js — Service Worker (Offline + Performance)
 * - Cache-first untuk assets (HTML/CSS/JS/Fonts/Icons) => SWR
 * - TIDAK mencegat request cross-origin (Apps Script & CDN)
 * ========================================================= */
const SW_VERSION  = 'tsh-erp-v5';            // bump version to update clients
const ASSET_CACHE = `${SW_VERSION}-assets`;
const API_CACHE   = `${SW_VERSION}-api`;     // (tersisa untuk future use)

// Core assets same-origin (eksternal akan di-fetch normal oleh browser)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './assets/tsh.png',
  // CATATAN: item eksternal sengaja tidak dimasukkan ke cache install
  // agar instalasi tidak gagal karena request opaque.
];

self.addEventListener('install', (e)=>{
  self.skipWaiting();
  e.waitUntil(
    caches.open(ASSET_CACHE).then(cache => cache.addAll(CORE_ASSETS)).catch(()=>{})
  );
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => ![ASSET_CACHE, API_CACHE].includes(k)).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// HANYA tangani request same-origin + GET (static assets)
self.addEventListener('fetch', (e)=>{
  const req = e.request;
  const url = new URL(req.url);

  // 1) Biarkan semua request cross-origin berjalan langsung ke network
  //    (Apps Script JSONP, CDN Chart.js, FontAwesome, SheetJS, dll)
  if (url.origin !== self.location.origin) return;

  // 2) Hanya GET yang dicache
  if (req.method !== 'GET') return;

  // 3) Stale-While-Revalidate untuk assets same-origin
  e.respondWith((async ()=>{
    const cache  = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);

    const fetchPromise = fetch(req).then(net=>{
      // simpan versi terbaru (abaikan jika gagal)
      cache.put(req, net.clone());
      return net;
    }).catch(()=>{
      // kalau fetch gagal dan tidak ada cache → tetap balas response valid
      if (cached) return cached;
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    });

    return cached || fetchPromise;
  })());
});
