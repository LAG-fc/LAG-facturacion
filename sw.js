// sw.js — permite instalar la página y que abra aunque no haya internet.
// Guarda en el celular/PC los archivos de la aplicación.
const VERSION = "remitos-v8.2.0";
const FILES = [
  "./", "index.html", "styles.css", "firebase-sdk.js", "firebase-config.js", "auth.js", "crop.js", "enhance.js", "period.js", "pdfcrypt.js", "pdftext.js", "ocparse.js", "factparse.js", "xlsx.js", "despachos.js", "pdf.js", "scanner.js", "oc.js", "digits-model.js", "digits-core.js", "rl.js", "lector.js", "logo-pdf.js", "logo.png",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-192.png", "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/favicon-16.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero se intenta bajar la versión nueva (así las actualizaciones llegan solas);
// si no hay internet, se usa la copia guardada.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
