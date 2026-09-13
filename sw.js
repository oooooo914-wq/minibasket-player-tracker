const PREFIX='minibasket-tracker-';
const CACHE=PREFIX+'v5.0.0';
const CORE=['./','./index.html','./styles.css','./app.js','./tracker.js','./ai-config.js',
  './detector-worker.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
const root=new URL('./',self.location.href);
const coreUrls=new Set(CORE.map(p=>new URL(p,root).href));
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));
  // Do not replace a running analysis. New versions activate after closing tabs.
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  // Only the application shell. Never cache local videos, frames or unrelated sites.
  if(url.origin!==root.origin||!coreUrls.has(url.href))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(event.request);
    return cached||fetch(event.request);
  })());
});

// Activated only through the user's explicit update button.
self.addEventListener('message',event=>{if(event.data?.type==='activateUpdate')self.skipWaiting();});
