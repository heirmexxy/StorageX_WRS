/* Keeps the gate app openable without network. App files: network first (so updates arrive), cache when offline.
   Uploads and the farmer list (/api/...) always go to the network; records themselves live in IndexedDB. */
var CACHE = 'sx-gate-3';
var SHELL = ['/intake/', '/intake/app.js', '/intake/intake.css', '/intake/manifest.webmanifest', '/intake/icon-192.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  var path = url.pathname === '/intake' || url.pathname === '/intake/index.html' ? '/intake/' : url.pathname;
  if (SHELL.indexOf(path) < 0) return;
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(path, copy); }); }
    return res;
  })['catch'](function () { return caches.match(path); }));
});
