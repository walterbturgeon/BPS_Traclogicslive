// Service worker de la page TRACKLOGICS MT (dossier mt/). Prefixe propre :
// la page fusion (draglog-trlg-) et celle-ci partagent l'origine, chacune ne
// nettoie que ses propres caches.
// ⚠ CE NUMERO DOIT MONTER A CHAQUE PUBLICATION : c'est lui qui declenche le
// rechargement automatique de la page (controllerchange).
const PREFIX = 'draglog-mt-';
const CACHE = PREFIX + 'v108';   // v108 : roues motrices, et l heritage champ par champ
const ASSETS = ['./', './index.html', './manifest.json', './icon-mt-192.png', './icon-mt-512.png', './logo-traclogics.jpg',
                './circuits_index.csv', './circuits_offsets.csv', '../circuits_index.csv', '../circuits_offsets.csv'];

self.addEventListener('install', (ev) => {
  // [v77] UN FICHIER ABSENT NE TUE PLUS L'INSTALLATION. addAll echoue en entier des qu'un
  // seul fichier manque : la page restait alors en « mise a jour... » pour toujours.
  ev.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});
self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// Reseau d'abord, cache en secours. Les requetes d'une autre origine (fond
// satellite) ne passent pas par ici.
self.addEventListener('fetch', (ev) => {
  if (new URL(ev.request.url).origin !== self.location.origin) return;
  if (ev.request.method !== 'GET') return;
  ev.respondWith(
    fetch(ev.request).then((resp) => { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copy)).catch(() => {}); return resp; })
      .catch(() => caches.match(ev.request).then((r) => r || Response.error()))
  );
});
