/**
 * auth-guard.js  —  Ritians Transport v4.1
 * Reads the student session from localStorage.
 * • Redirects to login.html if not logged in (protects page).
 * • Injects a student name chip + logout button into the nav bar.
 */
(function AuthGuard() {
  'use strict';

  const STORAGE_KEY  = 'ritians_student';
  const LOGIN_PAGE   = 'login.html';
  const PUBLIC_PAGES = ['login.html', 'signup.html'];

  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  const isPublic    = PUBLIC_PAGES.some(p => currentPage.includes(p));

  function getSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = LOGIN_PAGE;
  }
  window.authLogout = logout;

  function injectNavChip(student) {
    function doInject() {
      if (document.getElementById('authChip')) return;
      const navRight = document.querySelector('.nav-right');
      if (!navRight) return;

      // Markup/session data/logout behavior unchanged — only moved from
      // inline styles to classes (.auth-chip / .auth-chip-avatar /
      // .auth-chip-name / .auth-chip-logout), styled in mobile.css. This
      // keeps desktop pixel-identical while letting the mobile header
      // (index.html only) restyle the chip into a premium avatar treatment.
      const chip = document.createElement('div');
      chip.id = 'authChip';
      chip.className = 'auth-chip';
      chip.innerHTML = `
        <div class="auth-chip-avatar">${student.name.charAt(0).toUpperCase()}</div>
        <span class="auth-chip-name">${student.name.split(' ')[0]}</span>
        <button class="auth-chip-logout" onclick="authLogout()" title="Log out" aria-label="Log out">
          <i class="fas fa-arrow-right-from-bracket"></i>
        </button>`;

      const clock = navRight.querySelector('.clock');
      clock ? navRight.insertBefore(chip, clock) : navRight.appendChild(chip);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doInject);
    } else {
      doInject();
    }
  }

  const session = getSession();

  if (!session && !isPublic) {
    window.location.href = LOGIN_PAGE;
    return;
  }

  if (session && !isPublic) {
    injectNavChip(session);
    window.currentStudent = session;
  }
})();