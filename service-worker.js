/* =============================================================================
   Service worker — Vents Pornichet

   Stratégie :
   - app shell (HTML/CSS/JS/icônes) : précaché, servi hors-ligne ;
   - données de vent (windmorbihan, cross-origin) : réseau uniquement, jamais
     mises en cache ici — un relevé périmé servi comme actuel serait pire que
     pas de relevé du tout. Le cache court de l'historique est géré côté app
     (localStorage, TTL 20 min).
   ========================================================================== */
'use strict';

const CACHE = 'vents-pornichet-v1';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll est tout-ou-rien : on tolère l'échec d'une icône isolée.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Données de vent et tout autre domaine : on laisse passer sans intervenir.
  if (url.origin !== self.location.origin) return;

  // Navigation : réseau d'abord (pour récupérer une nouvelle version),
  // repli sur l'app shell en cache si hors-ligne.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Ressources statiques : cache immédiat + revalidation en arrière-plan.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    return cached || (await network) || Response.error();
  })());
});
