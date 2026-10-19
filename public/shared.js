(function() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const token = localStorage.getItem('token');
  if (!token) { window.location.href = '/auth.html'; }
})();

const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
const hasAdminRole = ['admin', 'superadmin'].includes(currentUser.role);
const hasSuperAdminRole = currentUser.role === 'superadmin';

function isAdminModeOn() {
  return hasAdminRole && localStorage.getItem('adminModeOn') === '1';
}

function setAdminMode(on) {
  localStorage.setItem('adminModeOn', on ? '1' : '0');
}

const isAdmin = isAdminModeOn();
const isSuperAdmin = hasSuperAdminRole && isAdminModeOn();

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  const icon = document.getElementById('themeIcon');
  if (icon) icon.textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('theme', next);
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('adminModeOn');
  window.location.href = '/auth.html';
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('token')}`
  };
}

function buildNav(activePage) {
  const saved = localStorage.getItem('theme') || 'light';
  const themeIcon = saved === 'dark' ? '☀️' : '🌙';
  const role = currentUser.role || 'student';
  const effectiveRole = isAdminModeOn() ? role : 'student';

    // Временно заморожено — легко разморозить, просто верни roles обратно
  // на ['student', 'admin', 'superadmin'] у нужного пункта.
  const FROZEN_SECTIONS = ['leaderboard', 'chat'];
  
  const allLinks = [
    { href: '/tests.html', label: 'Тесты', key: 'tests', icon: '📝', roles: ['student', 'admin', 'superadmin'] },
    { href: '/leaderboard.html', label: 'Лидеры', key: 'leaderboard', icon: '🏆', roles: ['student', 'admin', 'superadmin'] },
    { href: '/hiddenchat.html', label: 'Чат', key: 'chat', icon: '💬', roles: ['student', 'admin', 'superadmin'] },
    { href: '/profile.html', label: 'Профиль', key: 'profile', icon: '👤', roles: ['student', 'admin', 'superadmin'] },
    { href: '/admin.html', label: 'База', key: 'admin', icon: '📚', roles: ['admin', 'superadmin'] },
    { href: '/users.html', label: 'Люди', key: 'users', icon: '👥', roles: ['superadmin'] },
  ].filter(l => !FROZEN_SECTIONS.includes(l.key));

  const pageTitles = {
    home: 'Главная', tests: 'Тесты', leaderboard: 'Лидеры',
    chat: 'Чат', profile: 'Профиль', admin: 'База', users: 'Пользователи'
  };
  const mobilePageTitle = pageTitles[activePage] || '';

  const visibleLinks = allLinks.filter(l => l.roles.includes(effectiveRole));

  // Верхнее меню (десктоп) — без "Профиль", он отдельно справа как имя пользователя
  const topLinksHtml = visibleLinks
    .filter(l => l.key !== 'profile')
    .map(l => `<a href="${l.href}" class="nav-link ${activePage === l.key ? 'active' : ''}">${l.label}</a>`)
    .join('');

  const adminToggleHtml = hasAdminRole ? `
    <button class="admin-mode-toggle ${isAdminModeOn() ? 'active' : ''}" onclick="toggleAdminMode()" title="${isAdminModeOn() ? 'Выключить админский режим' : 'Включить админский режим'}">
      ${isAdminModeOn() ? '🛠️ Админ вкл' : '🛠️ Админ выкл'}
    </button>` : '';

  const topHeader = `
    <header class="header">
      <a href="/" class="logo logo-link">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="var(--primary)"/>
          <path d="M16 7v18M7 16h18" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
        </svg>
        <span class="logo-text">MED<span class="logo-accent">UP</span></span>
      </a>
      <nav class="nav-links">${topLinksHtml}</nav>
      <div style="display:flex; align-items:center; gap:10px;">
        ${adminToggleHtml}
        <span class="mobile-page-title">${mobilePageTitle}</span>
        <a href="/profile.html" class="user-name-link ${activePage === 'profile' ? 'active' : ''}">${currentUser.name || ''}</a>
      </div>
    </header>`;

  // Нижняя панель (мобильные) — включает "Профиль" явно, это основной мобильный паттерн
  const bottomLinksHtml = visibleLinks
    .map(l => `<a href="${l.href}" class="bottom-tab ${activePage === l.key ? 'active' : ''}">
        <span class="bottom-tab-icon">${l.icon}</span>
        <span class="bottom-tab-label">${l.label}</span>
      </a>`)
    .join('');

  const bottomBar = `<nav class="bottom-tab-bar">${bottomLinksHtml}</nav>`;

  return topHeader + bottomBar;
}

function initNav(activePage) {
  document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('navContainer');
    if (container) container.innerHTML = buildNav(activePage);
  });
}

function toggleAdminMode() {
  const wasOn = isAdminModeOn();
  setAdminMode(!wasOn);
  location.reload();
}

// Нижняя панель уезжает вниз, когда открыта клавиатура — работает на ЛЮБОЙ
// странице автоматически, без ручной разметки каждого поля ввода отдельно.
document.addEventListener('focusin', (e) => {
  const tag = e.target.tagName;
  const type = (e.target.type || '').toLowerCase();
  const isTextEntry = (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(type)) || tag === 'TEXTAREA';
  if (isTextEntry) document.body.classList.add('keyboard-open');
});

document.addEventListener('focusout', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') document.body.classList.remove('keyboard-open');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      registration.update();
    } catch (err) {
      console.error('Не удалось зарегистрировать service worker', err);
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.log('Установлена новая версия платформы — подхватится при следующем переходе между страницами');
  });
}

if (typeof getPendingCount === 'function') {
  window.addEventListener('load', async () => {
    const count = await getPendingCount();
    if (count > 0 && navigator.onLine) {
      await trySyncPendingResults(authHeaders);
    }
  });

  window.addEventListener('online', async () => {
    await trySyncPendingResults(authHeaders);
  });
}

// Скрытый вход в личную панель — активен только для id=1, для всех остальных
// пользователей полностью беззвучен: ни намёка в интерфейсе, ни какой-либо
// реакции при наборе этой фразы. Поле ввода намеренно исключено, чтобы не
// срабатывало случайно, если это слово когда-нибудь наберётся в чате или форме.
(function() {
  if (currentUser.id !== 1) return;
  const SECRET_PHRASE = 'sidqx2';
  let buffer = '';

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    buffer += e.key.toLowerCase();
    buffer = buffer.slice(-SECRET_PHRASE.length);
    if (buffer === SECRET_PHRASE) {
      window.location.href = '/hq.html';
    }
  });
})();