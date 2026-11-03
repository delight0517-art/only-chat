'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-workspace-status-'));
  const workspaceDir = path.join(profile, 'actual-workspace');
  let app;
  try {
    app = new DesktopServer({
      port: await freePort(),
      isolated: true,
      dataDir: profile,
      workspaceDir,
      enableQuotaRefresh: false
    });
    const { url } = await app.start();
    const response = await fetch(`${url}/api/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.workspaceDir, workspaceDir);
    assert.equal(body.defaultWorkspaceDir, workspaceDir);
    assert.equal(body.sessionWorkspaceDir, null, 'no session means no separate active session workspace');

    const resumedWorkspaceDir = path.join(profile, 'resumed-session-workspace');
    app.engine.priorityChain.setTiers([{ tier: 1, id: 'workspace-status-test', name: 'Workspace test', provider: 'synthetic', model: 'test-model', enabled: true }]);
    const createdSession = app.engine.sessions.createSession({ workspaceDir: resumedWorkspaceDir, title: 'Session workspace status' });
    app.engine.loadInternalSession(app.engine.sessions.resumeSession(createdSession.sessionId));
    const resumedResponse = await fetch(`${url}/api/status`);
    const resumedBody = await resumedResponse.json();
    assert.equal(resumedBody.defaultWorkspaceDir, workspaceDir, 'resuming a session does not change the launch default');
    assert.equal(resumedBody.sessionWorkspaceDir, resumedWorkspaceDir);
    assert.equal(resumedBody.workspaceDir, resumedWorkspaceDir, 'legacy workspaceDir continues to report the active session path');
    const nextSession = app.engine.initSession({ workspaceDir: app.engine.defaultWorkspaceDir, title: 'New default workspace session' });
    app.engine.loadInternalSession(app.engine.sessions.resumeSession(nextSession.sessionId));
    const newChatResponse = await fetch(`${url}/api/status`);
    const newChatBody = await newChatResponse.json();
    assert.equal(newChatBody.defaultWorkspaceDir, workspaceDir);
    assert.equal(newChatBody.sessionWorkspaceDir, workspaceDir, 'a new session after resume returns to the launch default workspace');

    const html = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
    const renderer = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
    assert.match(html, /새 채팅 기본 작업 폴더/);
    assert.match(html, /현재 세션 작업 폴더/);
    assert.match(html, /id="settingsDefaultCwdInput"[^>]*readonly/);
    assert.match(html, /id="settingsCwdInput"[^>]*readonly/);
    assert.match(renderer, /defaultWorkspaceRootInput\.value = data\.defaultWorkspaceDir/);
    assert.match(renderer, /workspaceRootInput\.value = data\.sessionWorkspaceDir \|\| data\.defaultWorkspaceDir \|\| data\.workspaceDir/);
    assert.match(renderer, /workspaceRootInput\.readOnly = true/);
    console.log('desktopWorkspaceStatus passed: default and active session workspaces reach separate read-only settings fields');
  } finally {
    app?.stop();
    fs.rmSync(profile, { recursive: true, force: true });
    assert.equal(fs.existsSync(profile), false, 'isolated test profile removed');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
