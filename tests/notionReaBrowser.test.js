'use strict';

const assert = require('node:assert/strict');
const { NotionReaBrowser, normalizeNotionUrl } = require('../src/browser/NotionReaBrowser.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');

async function main() {
  assert.equal(normalizeNotionUrl('https://workspace.notion.site'), 'https://workspace.notion.site/');
  assert.throws(() => normalizeNotionUrl('https://example.com'), /Notion 페이지에서만/);
  assert.throws(() => normalizeNotionUrl('http://www.notion.so'), /HTTPS Notion/);

  const calls = [];
  let mapCalls = 0;
  let blockAuthMode = false;
  const runScript = async (script, ...args) => {
    calls.push([script, ...args]);
    if (script === 'aside-nav.js') return { ok: true, stdout: 'task-tab only-chat-notion' };
    if (script === 'aside-map.js') {
      mapCalls++;
      if (blockAuthMode) return { ok: true, stdout: '# page: Sign in\n# url: https://www.notion.so/login\n- textbox "Password" [ref=7]' };
      if (mapCalls === 1) return { ok: true, stdout: '# page: Home\n# url: https://www.notion.so\n- button "Search" [ref=3]' };
      if (mapCalls === 2) return { ok: true, stdout: '# page: Home\n# url: https://www.notion.so\n- textbox "Search" [ref=5]' };
      return { ok: true, stdout: '# page: Search\n# url: https://www.notion.so/search\n- link "Pomodoro notes" [ref=9]' };
    }
    if (script === 'aside-act.js') return { ok: true, stdout: 'action complete' };
    if (script === 'aside-read.js') return { ok: true, stdout: 'Pomodoro page text' };
    return { ok: false, stderr: `unexpected ${script}` };
  };
  const browser = new NotionReaBrowser({
    policy: { check: async url => ({ allowed: true, url }) },
    runScript,
    runtimeCheck: async () => ({ ready: true, scriptsAvailable: true, puppeteerAvailable: true, cdpConnected: true }),
    wait: async () => {}
  });

  await browser.open();
  const result = await browser.search('Pomodoro');
  assert.equal(result.query, 'Pomodoro');
  assert.match(result.results, /Pomodoro notes/);
  assert.equal(result.text, 'Pomodoro page text');
  assert.ok(calls.some(call => call[0] === 'aside-act.js' && call[1] === 'task-tab' && call[2] === 'ref=3' && call[3] === 'click'));
  assert.ok(calls.some(call => call[0] === 'aside-act.js' && call[1] === 'task-tab' && call[2] === 'ref=5' && call[3] === 'type' && call[4] === 'Pomodoro'));

  blockAuthMode = true;
  await assert.rejects(() => browser.act({ ref: '7', action: 'type', text: 'secret' }), /인증 정보 입력을 대신하지 않습니다/);
  blockAuthMode = false;
  mapCalls = 0;
  const engine = Object.create(AgentEngine.prototype);
  engine.tools = { approvalPolicy: 'on-request', notionReaSearch: query => browser.search(query), isNotionMcpReadOnlyCall: () => false };
  const routedSearch = await engine._executeToolCall({ name: 'notion_rea_search', args: { query: 'notes' } });
  assert.equal(routedSearch.query, 'notes');

  const unavailable = new NotionReaBrowser({
    policy: { check: async url => ({ allowed: true, url }) },
    runtimeCheck: async () => ({ ready: false, scriptsAvailable: true, puppeteerAvailable: false, cdpConnected: false, reason: 'puppeteer-core missing' })
  });
  assert.deepEqual(await unavailable.status(), {
    available: false, ready: false, reason: 'puppeteer-core missing', cdpConnected: false,
    puppeteerAvailable: false, scriptsAvailable: true, targetId: null, activeUrl: null
  });
  await assert.rejects(() => unavailable.open(), /puppeteer-core missing/);
  console.log('Notion REA restricts URLs, routes search through the tool registry, returns results/body, and blocks credential entry');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
