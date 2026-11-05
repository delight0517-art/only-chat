'use strict';

async function manageRouterAccount(adapter, input, fetchImpl = globalThis.fetch) {
  if (!adapter || typeof adapter.baseUrl !== 'string') throw Object.assign(new Error('AI Account Router 연결이 필요합니다.'), { status: 503 });
  const base = new URL(adapter.baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/') {
    throw Object.assign(new Error('Invalid local Router address.'), { status: 400 });
  }
  const { action, accountId } = input;
  let endpoint, method = 'POST', body;
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 80)) throw Object.assign(new Error('계정 이름은 80자 이내로 입력해 주세요.'), { status: 400 });
  if (action === 'add-chatgpt') {
    endpoint = '/api/oauth/chatgpt/start';
    const id = `chatgpt-${require('node:crypto').randomUUID()}`;
    body = { id, name: input.name?.trim() || `ChatGPT ${id.slice(-6)}`, model: 'auto' };
  } else if (action === 'refresh-antigravity') {
    const chain = await adapter.getChain();
    const current = chain.accounts.filter(account => account.provider === 'antigravity-cli');
    if (current.length > 1) throw Object.assign(new Error('Antigravity 프로필이 여러 개입니다. 제공자 앱에서 실제 계정 연결을 먼저 확인해 주세요.'), { status: 409 });
    endpoint = '/api/antigravity/refresh';
    body = { id: current[0]?.id || 'antigravity-google', name: current[0]?.name || 'Antigravity 현재 로그인' };
  } else if (['remove', 'reauth'].includes(action)) {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128) throw Object.assign(new Error('계정을 선택해 주세요.'), { status: 400 });
    const chain = await adapter.getChain();
    const account = chain.accounts.find(item => item.id === accountId && item.provider !== 'demo');
    if (!account) throw Object.assign(new Error('등록된 계정을 찾을 수 없습니다.'), { status: 404 });
    if (action === 'remove') { method = 'DELETE'; endpoint = `/api/accounts/${encodeURIComponent(accountId)}`; }
    else if (account.provider === 'chatgpt-plan') endpoint = `/api/accounts/${encodeURIComponent(accountId)}/reconnect`;
    else throw Object.assign(new Error('이 계정은 제공자 앱에서 다시 로그인해 주세요. 현재 계정은 유지됩니다.'), { status: 409 });
  } else throw Object.assign(new Error('지원하지 않는 계정 작업입니다.'), { status: 400 });
  const response = await fetchImpl(`${base.origin}${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: base.origin },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result?.error?.message || '계정 작업을 완료하지 못했습니다.'), { status: response.status });
  // OAuth state and credentials stay in Router. The UI refreshes public account metadata.
  return { ok: true, pending: action === 'add-chatgpt' || action === 'reauth' };
}

module.exports = { manageRouterAccount };
