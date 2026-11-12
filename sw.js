// Ma PAC — fonctionnement hors connexion.
// La page : réseau d'abord (toujours la dernière version en ligne), sinon la copie gardée.
// Icônes / manifeste / police : copie gardée. Les autres sites (relais, météo, Tempo) ne passent jamais par ici.
// v112 : une page d'erreur (404/500…) n'écrase plus la copie gardée ; réseau trop lent (> 4 s) → copie gardée tout de suite ;
//        icônes sans « ?v= » (même adresse que la copie gardée) ; police Inter hébergée avec l'appli.
const CACHE = 'ma-pac-v2.03';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './fonts/inter-latin.woff2'];
const NET_TIMEOUT = 4000;
self.addEventListener('install', e => {
  // chaque fichier séparément : un fichier absent ne bloque pas l'installation
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
function timed(p, ms) { return new Promise((ok, ko) => { const t = setTimeout(() => ko(new Error('timeout')), ms); p.then(v => { clearTimeout(t); ok(v); }, err => { clearTimeout(t); ko(err); }); }); }
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // relais, météo… : jamais en cache
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')) {
    const net = fetch(req).then(r => {
      if (r && r.ok && r.type === 'basic') { const c = r.clone(); caches.open(CACHE).then(x => x.put('./index.html', c)); }
      return r;
    });
    e.respondWith(timed(net, NET_TIMEOUT)
      .then(r => (r && r.ok) ? r : caches.match('./index.html').then(m => m || r))
      .catch(() => caches.match('./index.html').then(m => m || net)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(m => m || fetch(req).then(r => {
    if (r && r.ok && r.type === 'basic') { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
