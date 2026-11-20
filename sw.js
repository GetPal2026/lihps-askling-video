const CACHE='lihps-askling-video-pwa-0030';
const SHELL=['./','./index.html','./app.js','./metrics.js','./analysis.js','./review.js','./media.js','./style.css','./manifest.webmanifest',
  './icons/askling-video-180.png','./icons/askling-video-192.png','./icons/askling-video-512.png','./icons/askling-video-maskable-512.png'];
self.addEventListener('install', event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('lihps-askling-video-pwa-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if (req.method!=='GET') return;
  const allowed=req.url.startsWith(self.registration.scope) ||
    req.url.startsWith('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/') ||
    req.url.startsWith('https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/') ||
    req.url.startsWith('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/');
  if (!allowed) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if (req.mode==='navigate') {
      try {return await fetch(req);} catch {return (await cache.match('./index.html')) ?? Response.error();}
    }
    const cached=await cache.match(req);
    if (cached) return cached;
    const response=await fetch(req);
    if (response.ok || response.type==='opaque') {
      try {await cache.put(req,response.clone());} catch {}
    }
    return response;
  })());
});
