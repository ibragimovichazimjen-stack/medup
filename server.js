require('dotenv').config();
const express = require('express');
const pool = require('./db');
const cors = require('cors');
const testsRouter = require('./routes/tests');
const authRouter = require('./routes/auth');
const announcementsRouter = require('./routes/announcements');
const statsRouter = require('./routes/stats');
const resultsRouter = require('./routes/results');
const versionsRouter = require('./routes/versions');
const hiddenChatRouter = require('./routes/hiddenchat');
const ownerRouter = require('./routes/owner');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// sw.js теперь генерируется динамически при каждом запросе — сервер сам
// подставляет последний опубликованный номер версии из раздела "Версии",
// так что ручная синхронизация числа больше не нужна вообще никогда.
// Публикуешь новую версию как обычно — кэш подхватывает её сам.
app.get('/sw.js', async (req, res) => {
  try {
    const versionResult = await pool.query('SELECT version_number FROM versions ORDER BY created_at DESC LIMIT 1');
    const versionNumber = versionResult.rows[0]?.version_number || '1.0';

    const swContent = `
const CACHE_VERSION = 'medup-shell-v${versionNumber}';

const APP_SHELL = [
  '/',
  '/index.html',
  '/auth.html',
  '/tests.html',
  '/exam.html',
  '/admin.html',
  '/users.html',
  '/profile.html',
  '/editor.html',
  '/hiddenchat.html',
  '/leaderboard.html',
  '/style.css',
  '/chat.css',
  '/shared.js',
  '/offline.js',
  '/manifest.json',
];

const API_PREFIXES = ['/tests/', '/auth/', '/results/', '/hiddenchat/', '/chat-uploads/', '/announcements', '/versions', '/stats', '/owner/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApi = API_PREFIXES.some(p => url.pathname.startsWith(p));

  if (isApi || event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
`;

    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(swContent);
  } catch (err) {
    console.error('Не удалось сгенерировать sw.js', err);
    res.status(500).send('// Ошибка генерации service worker');
  }
});

app.use(express.static('public'));
app.use('/chat-uploads', express.static('uploads/chat'));

app.use('/tests', testsRouter);
app.use('/auth', authRouter);
app.use('/announcements', announcementsRouter);
app.use('/stats', statsRouter);
app.use('/results', resultsRouter);
app.use('/versions', versionsRouter);
app.use('/hiddenchat', hiddenChatRouter);
app.use('/owner', ownerRouter);


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});