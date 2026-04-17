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

      const chip = document.createElement('div');
      chip.id = 'authChip';
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(78,205,196,0.10);border:1px solid rgba(78,205,196,0.25);border-radius:99px;padding:5px 12px 5px 8px;font-size:12px;color:#4ECDC4;font-family:"DM Sans",sans-serif;flex-shrink:0;';
      chip.innerHTML = `
        <div style="width:24px;height:24px;border-radius:50%;background:rgba(78,205,196,0.2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#4ECDC4;">${student.name.charAt(0).toUpperCase()}</div>
        <span style="font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${student.name.split(' ')[0]}</span>
        <button onclick="authLogout()" title="Log out" style="background:none;border:none;color:#5A6A8A;cursor:pointer;font-size:12px;padding:0;line-height:1;" onmouseover="this.style.color='#F87171'" onmouseout="this.style.color='#5A6A8A'">
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
