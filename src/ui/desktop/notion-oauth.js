'use strict';

(() => {
  const button = document.getElementById('btnLoginNotion');
  if (!button) return;
  const status = document.getElementById('notionOAuthStatus');
  const badge = document.getElementById('badgeNotionStatus');

  function showUrlCopyFallback(url, message) {
    document.getElementById('notionLoginUrlFallback')?.remove();
    const panel = document.createElement('div');
    panel.id = 'notionLoginUrlFallback';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.style.cssText = 'display:grid;gap:8px;margin-top:8px;padding:10px;border:1px solid var(--border-color,#555);border-radius:8px;';
    const note = document.createElement('p');
    note.textContent = message;
    note.style.margin = '0';
    const input = document.createElement('input');
    input.type = 'url';
    input.readOnly = true;
    input.value = url;
    input.setAttribute('aria-label', 'Notion 로그인 URL');
    input.style.width = '100%';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn-primary';
    copy.textContent = "If it didn't open, click to copy URL";
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
        await navigator.clipboard.writeText(url);
        copy.textContent = 'The link has been copied. Go to a browser and then paste it.';
      } catch {
        input.focus();
        input.select();
        copy.textContent = document.execCommand('copy')
          ? 'The link has been copied. Go to a browser and then paste it.'
          : '주소가 선택됐습니다. 직접 복사해 주세요';
      }
    });
    panel.append(note, input, copy);
    (status?.parentElement || button.parentElement || document.body).append(panel);
  }

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Notion 로그인 주소를 준비하고 있습니다…';
    let loginUrl = '';
    let timer;
    try {
      const response = await fetch('/api/connectors/notion/auth-url', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || 'Notion 로그인 주소를 만들지 못했습니다.');
      loginUrl = result.url;
      let opened = null;
      try { opened = window.open(result.url, '_blank', 'width=620,height=780'); } catch (_) {}
      if (opened) opened.opener = null;
      status.textContent = opened
        ? 'Notion 로그인 후 Only Chat에 공유할 페이지를 선택하고 허용해 주세요. 창이 보이지 않으면 아래 링크 복사 버튼을 사용하세요.'
        : 'Notion 로그인 창이 열리지 않았습니다. 아래 URL 복사를 눌러 브라우저에서 계속하세요.';
      showUrlCopyFallback(loginUrl, "If it didn't open, click to copy URL. Go to a browser and then paste it.");

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
      if (loginUrl) showUrlCopyFallback(loginUrl, `Notion 로그인 창을 열지 못했습니다. 주소를 복사해 브라우저에서 계속하세요. (${error.message || '오류'})`);
      status.textContent = error.message || 'Notion 로그인을 시작하지 못했습니다.';
    }
  });
})();
