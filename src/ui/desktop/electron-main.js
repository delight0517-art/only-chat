'use strict';

const { app, BrowserWindow, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DesktopServer } = require('./server.js');
const { EmbeddedBrowser } = require('../../browser/EmbeddedBrowser.js');
const { FocusFencePolicy } = require('../../browser/FocusFencePolicy.js');

let server;
let window;
const isolatedProfileDir = process.env.ONLY_CHAT_ISOLATED_PROFILE || null;
const isolated = process.env.ONLY_CHAT_TEST_MODE === '1' || !!isolatedProfileDir;
if (isolated) {
  if (!isolatedProfileDir || !path.isAbsolute(isolatedProfileDir)) throw new Error('Set ONLY_CHAT_ISOLATED_PROFILE to an absolute temporary directory.');
  const resolvedProfile = path.resolve(isolatedProfileDir);
  const tempRoot = path.resolve(os.tmpdir());
  const lexicalRelative = path.relative(tempRoot, resolvedProfile);
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) throw new Error('ONLY_CHAT_ISOLATED_PROFILE must be a dedicated directory inside the system temporary folder.');
  let ancestor = resolvedProfile;
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestorRelative = path.relative(fs.realpathSync(tempRoot), fs.realpathSync(ancestor));
  if (realAncestorRelative === '..' || realAncestorRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realAncestorRelative)) throw new Error('ONLY_CHAT_ISOLATED_PROFILE resolves outside the system temporary folder.');
  fs.mkdirSync(resolvedProfile, { recursive: true });
  const realRelative = path.relative(fs.realpathSync(tempRoot), fs.realpathSync(resolvedProfile));
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('ONLY_CHAT_ISOLATED_PROFILE must resolve to a dedicated directory inside the system temporary folder.');
  app.setPath('userData', path.join(isolatedProfileDir, 'electron-profile'));
  app.setPath('sessionData', path.join(isolatedProfileDir, 'electron-profile', 'session-data'));
}

async function start() {
  const workspaceDir = isolated ? path.join(isolatedProfileDir, 'workspace') : path.join(app.getPath('documents'), 'Only Chat');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const browser = isolated ? null : new EmbeddedBrowser({ BrowserWindow, session: session.fromPartition('persist:onlychat-browser'), policy: new FocusFencePolicy() });
  server = new DesktopServer({ port: Number(process.env.PORT) || 8899, workspaceDir, browser, isolated, dataDir: isolatedProfileDir, openExternal: target => shell.openExternal(target) });
  const { url } = await server.start();
  window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 620,
    title: 'Only Chat',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  await window.loadURL(url);
  void server.resumeInterruptedTurn().catch(error => {
    console.error('Only Chat restart recovery failed:', error?.message || error);
  });
}

app.whenReady().then(start).catch(error => {
  console.error('Only Chat failed to start:', error);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.stop());
