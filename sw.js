/* =========================================================
 * sw.js — Service Worker (Offline + Performance)
 * - Cache-first untuk assets (HTML/CSS/JS/Fonts/Icons) => SWR
 * - Network-first untuk API GET ke Apps Script, fallback ke cache
 * ========================================================= */
const SW_VERSION = 'tsh-erp-v4';
const ASSET_CACHE = `${SW_VERSION}-assets`;
const API_CACHE = `${SW_VERSION}-api`;

// Sesuaikan origin dari proyek kamu (pakai self.location.origin untuk same-origin)
const API_BASE = 'https://script.google.com/macros/s/AKfycbyqIp-Y5xuWH6FXXqZCgqL4BFwuPfFQ_YW6KWvXpJo1-eA9zB3Uhs_p9hcjUryR8Q2w/exec';

const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './assets/tsh.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js',
];

self.addEventListener('install', (e)=>{
  self.skipWaiting();
  e.waitUntil(
    // addAll ke origin selain same-origin kadang gagal (opaque) → diamkan
    caches.open(ASSET_CACHE).then(cache=> cache.addAll(CORE_ASSETS).catch(()=>{}))
  );
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=> Promise.all(
      keys.filter(k=> ![ASSET_CACHE, API_CACHE].includes(k)).map(k=> caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  const url = new URL(req.url);

  // Only GET requests are cachable
  if(req.method !== 'GET') return;

  // API GET — network-first dengan cache fallback (offline-friendly)
  if (url.href.startsWith(API_BASE)) {
    e.respondWith((async ()=>{
      try{
        const net = await fetch(req);
        const cache = await caches.open(API_CACHE);
        cache.put(req, net.clone());
        return net;
      }catch{
        const cached = await caches.match(req);
        if(cached) return cached;
        // fallback kosong jika tidak ada cache
        return new Response(JSON.stringify({ok:false,error:'offline'}), {headers:{'Content-Type':'application/json'}});
      }
    })());
    return;
  }

  // Assets — stale-while-revalidate
  e.respondWith((async ()=>{
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);
    // FIX: Pastikan selalu mengembalikan Response valid meskipun fetch gagal
    const fetchPromise = fetch(req).then(net=>{
      cache.put(req, net.clone());
      return net;
    }).catch(()=>{
      // Jika fetch gagal dan tidak ada cache, kembalikan Response 504,
      // jangan mengembalikan undefined (yang memicu TypeError di respondWith).
      if (cached) return cached;
      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    });
    return cached || fetchPromise;
  })());
});
