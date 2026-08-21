/* Wan Code PWA shell. Never listen. Never cache credentials. */
'use strict';
const CACHE = "wancode-pwa-shell-v12";
const SHELL = ["/","/index.html","/manifest.webmanifest","/sw.js","/pair.js","/icons/wancode-192.png","/icons/wancode-512.png"];
const CREDENTIAL_QUERY = /token|secret|credential|password|authorization/iu;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.username !== "" || url.password !== "") return;
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY.test(key)) return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((hit) => hit || fetch(request))));
});
