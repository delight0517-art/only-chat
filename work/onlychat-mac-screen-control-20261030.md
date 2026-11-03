# Only Chat Mac screen control checkpoint

Date: 2026-10-30 KST
Task: `onlychat-mac-screen-control-20261030`
Source: `/Users/rogan/.gemini/antigravity/scratch/my-codex` (non-Git Antigravity scratch tree)

## Implemented source slice

- Default-off persisted opt-in setting, Only Chat panel toggle, explicit Screen Recording/Accessibility permission action, permission status, and transient in-app screenshot preview.
- Native WKWebView bridge for ScreenCaptureKit screenshot, coordinate click, bounded text/key input, and bounded scroll. Actions require the matching macOS permission.
- Local MCP tools for Codex CLI only. The short-lived bridge token is randomly generated per server run and passed to that Codex child only. Requests are loopback-only, authenticated, action-bounded, and rejected when opt-in is off. The MCP is only attached when the running server advertises the native Swift bridge; Electron and isolated previews cannot enable it.
- A fresh screen capture is required before every mouse/keyboard/scroll action; any action invalidates that captured-screen permission to act until the model captures again.
- Current screenshot image is returned to the current model conversation; app source does not write a screenshot file. The UI removes its preview reference when the user switches the feature off.
- macOS 14 or newer is required for the ScreenCaptureKit single-frame API used here. Capture currently targets the primary display.

## Source checks

- Passed: `swiftc -frontend -parse macOS/OnlyChatApp.swift`.
- Passed: JavaScript syntax checks for the changed server, UI, Codex adapter, and MCP module.
- Passed: `tests/macScreenControl.test.js` (default-off setting, tool exposure, absent-token rejection, authenticated local queue, synthetic capture, look-before-action requirement, and synthetic completion).
- Passed: `tests/codexCliAdapter.test.js`, `tests/desktopServerSecurity.test.js`, `tests/threefBrowserHandoff.test.js`, `tests/googleWorkspaceMcpServer.test.js`, `tests/connectors.test.js`, `tests/approvalPolicy.test.js`, and `src/features/provider/v1.test.mjs`.
- Full Swift typecheck was attempted but could not finish: a referenced external 3F Browser source changed during the compile, and that source set currently has an unresolved `YouTubePreviewPlaybackBlocker` symbol. No external 3F source was edited. The installed app was not built, installed, restarted, or runtime-tested.

## Changed files

`src/browser/MacScreenControlSettings.js`, `src/connectors/MacScreenControlMcpServer.js`, `src/ui/desktop/server.js`, `src/ui/desktop/app.js`, `src/ui/desktop/index.html`, `src/ui/desktop/app.css`, `src/providers/CodexCliAdapter.js`, `macOS/OnlyChatApp.swift`, `scripts/build-macos-app.sh`, `tests/macScreenControl.test.js`, `tests/codexCliAdapter.test.js`, `package.json`, `README.md`, and `TODO_ROADMAP.md`.

## Remaining verification

- Reconcile the unstable external 3F Browser dependency source, then compile the complete Only Chat native app.
- After the existing Only Chat draft is safely saved and the user resumes, build/install the updated app, use the settings button to request macOS permissions, and verify a safe capture and controlled test-window action.
- Windows implementation and receipt are separate; this patch is Mac-only.

## Final bounded verification update

- Re-ran and passed: syntax checks for changed JavaScript; `tests/macScreenControl.test.js`; `tests/codexCliAdapter.test.js`; `tests/desktopServerSecurity.test.js`; `tests/threefBrowserHandoff.test.js`; and Swift parser check.
- The earlier full `npm test` attempt fails in the unrelated existing `tests/priorityChain.test.js:116` renderer-string assertion. This appears to be the already-reported priority/account visibility issue and was not modified as part of the screen-control slice.
- The full native Swift typecheck remains blocked by the unstable external 3F source set; syntax parsing passes. No build/install/runtime or actual screen permission/click was performed.
- Existing user-action checkpoint remains: save the open Only Chat draft and reply `재개` before replacing/restarting the installed app for native runtime validation. No duplicate alert was sent.
