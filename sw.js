// Offline support (everything is served from this site; no CDN or font service): keep the app shell cached so it opens without a connection.
// Supabase requests always go to the network; the app keeps its own copy of your data.
const VERSION = 'semester-v16';
const SHELL = ['./', './index.html', './rules.js', './sync.js', './data.js', './models.js', './ui.js', './features/overview.js', './features/plan.js', './features/courses.js', './features/schedule.js', './features/item.js', './features/feed.js', './features/chat.js', './features/questions.js', './features/notes.js', './features/settings.js', './features/account.js', './router.js',
  './legacy.html', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
  './vendor/supabase.js', './vendor/figtree-latin.woff2'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || (url.pathname.endsWith('.js') && !url.pathname.includes('/vendor/'))) {
    // network first for the page and the app's own scripts, so a new version shows up right away when online
    // and the scripts never mismatch each other (vendor files are fixed and served from the cache)
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
});
