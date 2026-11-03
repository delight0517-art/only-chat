'use strict';

(() => {
  const button = document.getElementById('btnLoginNotion');
  if (!button) return;
  const status = document.getElementById('notionOAuthStatus');
  const badge = document.getElementById('badgeNotionStatus');

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Notion 로그인 주소를 준비하고 있습니다…';
    let timer;
    try {
      const response = await fetch('/api/connectors/notion/auth-url', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || 'Notion 로그인 주소를 만들지 못했습니다.');
      const opened = window.open(result.url, '_blank', 'width=620,height=780');
      if (opened) opened.opener = null;
      status.textContent = 'Notion 로그인 후 Only Chat에 공유할 페이지를 선택하고 허용해 주세요.';

      const startedAt = Date.now();
      timer = setInterval(async () => {
        if (Date.now() - startedAt > 10 * 60_000) {
          clearInterval(timer);
          timer = null;
          button.disabled = false;
          status.textContent = '로그인 대기가 끝났습니다. Notion 승인을 마친 뒤 다시 확인해 주세요.';
          return;
        }
        try {
          const check = await fetch('/api/connectors/notion/auth-status', { cache: 'no-store' });
          const current = await check.json();
          if (!current.connected) return;
          clearInterval(timer);
          timer = null;
          button.disabled = false;
          status.textContent = 'Notion에 연결됐습니다. 승인된 페이지를 Only Chat에서 사용할 수 있습니다.';
          badge.textContent = '● Notion 개인 계정 연결됨';
          badge.style.color = '#10b981';
          if (typeof window.refreshConnectorsStatus === 'function') void window.refreshConnectorsStatus();
        } catch (_) {}
      }, 2000);
    } catch (error) {
      if (timer) clearInterval(timer);
      button.disabled = false;
      status.textContent = error.message || 'Notion 로그인을 시작하지 못했습니다.';
    }
  });
})();
