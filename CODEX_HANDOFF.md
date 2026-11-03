# Only Chat handoff (2026-10-27)

## Verified state

- Source: `/Users/rogan/.gemini/antigravity/scratch/my-codex` (Antigravity scratch directory; no Git metadata).
- Product shape: Node.js CLI and a local web UI. This Mac now has `~/Applications/Only Chat.app`, a native WKWebView wrapper over the local Node.js server.
- Build: `scripts/build-macos-app.sh` creates the local development-signed app. The app depends on this Mac's Antigravity source folder and Node.js; it is not a portable Windows installer.
- Google Drive: `OnlyChat_NCHISim_Sync` contains project source and Windows launch scripts. Source files and the sync manifest were read back through the Drive connector.
- Windows: Drive upload does not prove the Windows PC received or ran the files. Windows app startup, installed package, and bidirectional sync are unverified.
- Windows packaging: `WINDOWS-BUILD.md` documents an Electron NSIS installer and self-contained portable ZIP, built with Node.js 22.12+ using `npm ci` and `npm run build:windows`. Windows runtime behavior still needs a Windows check.
- Browser integration: the Electron host has an isolated Chromium window used by the agent browser tools and reads current Focus Fence rules from its local `/rules` API. It blocks matching main-frame, redirect, SPA, and subframe URLs and fails closed when rules are unavailable. Electron does not load Focus Fence's Chrome extension; page filtering and YouTube time-budget parity remain incomplete. macOS still uses the native WKWebView wrapper and Aside-backed browser tools.
- REA: the external REA CLI was used to statically inspect selected Only Chat code and the installed ChatGPT app. This is development analysis, not an embedded product feature or proof of runtime behavior.
- Focused Mac checks passed for OAuth state validation, local server origin checks, browser CLI argument handling, installed-app listing, skill-cache lookup, and TODO-202 full-text search. The native app bundle passed signature verification and its local server returned HTTP 200.

## Changes in this update

- Validate one-time Google OAuth state on callback.
- Reject unexpected Host/Origin requests to the local desktop server.
- Pass browser CLI input as arguments instead of interpolating it into a shell command.
- Remove the simulated REA blueprint response and report installed applications instead.
- Search configured and standard nested Codex skill-cache paths.
- Add a macOS WKWebView app wrapper and replace the false REA/92% label with `로컬 앱 후보`.
- Add TODO-202 full-text search across Codex rollout and Antigravity transcript user/assistant messages, with bounded matching snippets and a 200-character query limit.
- Update tests and delivery notes for these changes.

## Remaining work

1. Windows user/device availability must be freshly confirmed before accessing that machine.
2. On Windows, read the Drive handoff, run the Node.js launch path, and confirm the app opens.
3. Verify a Mac edit reaches Windows and a Windows edit reaches Mac; verify a simultaneous edit preserves both versions.
4. Verify installed-app framework detection on additional Mac and Windows installations; the current route reports local app candidates and does not measure token savings.
5. Build the portable folder and Electron `.exe` outputs on Windows using `WINDOWS-BUILD.md`, then launch and verify each result there.

## Useful commands

```sh
npm test
node bin/codex.js app
```

On Windows, use `run-windows.ps1` from the Drive handoff folder after Node.js is available. Windows execution has not been checked from this Mac.
