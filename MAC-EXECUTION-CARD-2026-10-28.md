# Mac Only Chat execution card — 2026-10-28

- Owner: Codex thread `01a17ab5-ab16-7f41-95ae-b55c737fc61a`.
- Canonical Mac source: `/Users/rogan/.gemini/antigravity/scratch/my-codex`, package `1.0.1`; this Antigravity scratch tree has no Git metadata.
- Current app state: no Only Chat process was running when inspected.
- Existing source state: preserved in place. This work owns only the session/sidebar adapter and its focused fixture.
- First slice: populate pinned and Codex project groups from read-only native session data; render sessions into those groups without static placeholder chat titles; keep the existing Mac-only search and Antigravity paths.
- Files: `src/core/NativeSessionBridge.js`, `src/ui/desktop/app.js`, `src/ui/desktop/app.css`, `src/ui/desktop/index.html`, `tests/nativeSessionBridge.test.js`.
- Caller check: `listUnifiedSessions` is called by `src/ui/desktop/server.js`; it remains synchronous for this slice. Session opening continues through the existing `loadSession` route.
- Focused check: `node tests/nativeSessionBridge.test.js` with synthetic SQLite fixtures and temporary transcript files; no live chat DB writes.
- Next Windows-derived slices to inspect after this one: streaming text layout, provider/account adapters, voice/STT, and opt-in evolution relay. Each requires its own scope and check.
- Not in this slice: installing/restarting the Mac app, changing live account settings, enabling Drive sync, porting Windows paths, or modifying user chat/session data.

## Baseline hashes before the first source edit

```
974e2b848202c7eafd9c148e28e63ffa6270333050c9db1f98beca4650050fdf  src/core/NativeSessionBridge.js
dfbc9cb1e30b1fa7219120c7ae7e729e2a51b56472dff66b9c778125fcf0352b  src/ui/desktop/app.js
fa2024b7133549a3f68c3f2e81127a27d25dd977e9827c3b23f432a482517390  src/ui/desktop/index.html
32f47d03b89fe2ed131aee308e099c33569be9a76a0e65040f67ef4c34c6e505  tests/nativeSessionBridge.test.js
8a57546285f48a4aa8f97dabf1bdf51f1ccc8e4b628fcc42c0ca29cf3f72c769  src/ui/desktop/app.css
```

The working tree cannot produce a Git commit or branch integration because it has no `.git` directory. Source changes will be tracked by this card, focused test result, and post-change hashes; they must not be reported as committed.

## Slice 1 result

- Native Codex session and project SQLite reads now use read-only URI connections and tolerate optional/older columns. Archived sessions are excluded when that column exists.
- The sidebar now renders real pinned sessions and expandable project groups; it no longer presents hard-coded example chats/projects. Search and source filters retain their existing routes.
- Focused check passed: `node tests/nativeSessionBridge.test.js`; JavaScript syntax checks passed for `NativeSessionBridge.js` and `app.js`.
- Post-change SHA-256:

```
a6667522d0a78c9f010af27b4d710e9dbc62ffaf6ad54ce4b9f4fcb5d73ee144  src/core/NativeSessionBridge.js
54fbe3ea16675a4e48465e321607f2cb0abf462b30ec8d89664b556d541b5604  src/ui/desktop/app.js
c72451848b74e5e52c4d7e7f680b45926cae47becab09bca8f3743b035ea4bb5  src/ui/desktop/app.css
e5645676c46426672699ab8c041d7d1f38b275924621a87114a72e9e70d06a6c  src/ui/desktop/index.html
af5448a3f5fb10bcd6cb5062536f7d1f973f93b01a5bc496147e5c0d817499b5  tests/nativeSessionBridge.test.js
```

- Not done in this slice: live UI/runtime, macOS app build/install, Windows ACK, other Only Chat parity features, Software Teacher, or F3 Browser.

## Slice 4 — Evolution shared-state transport foundation

- Windows Drive handoff contracts inspected: `SHARED_STATE_CONTRACT.md` and `MAC_WINDOWS_EVOLUTION_SYNC.md`. The supported relay is an explicitly selected local folder; cloud replication is not proven by a local write.
- Added `src/morph/SharedStateReplica.js` for bounded declarative settings/schedule snapshots, SHA-256 parent chains, compare-and-swap revision checks, local publish lock, atomic records, capability-gated apply, persisted readback ACKs, and cross-platform ACK status. It contains no Drive OAuth, watcher, schedule executor, provider calls, app restart, or automatic publisher.
- Added `tests/sharedStateReplica.test.js` and inserted it in the normal test command. The hub and renderer do not configure/use this transport yet; runtime opt-in/settings UI and Mac-specific theme/font/layout adapter are still required before this can sync real app state.
- Retired the Mac server's legacy whole-workspace `/api/sync/*` copier and removed its always-off engine wiring. These endpoints now reject; isolated-runtime test was updated.
- Focused checks passed: replica (4 cases including conflict, unsafe values, schedule validation, damaged ancestry and exact readback ACK), desktop server origin/retired-sync gate, isolated runtime, Morph Hub, and JavaScript syntax checks.
- No Mac app was launched, built or installed. No Drive path was configured; no cloud receipt, Windows receiver ACK or app-runtime sync is claimed. The scratch source has no Git metadata; `agent-coord` therefore cannot lease/commit it. Changes are tracked in this card and hashes.

## Slice 2 scope before edit — streamed assistant text

- Expected behavior: consecutive `message_delta` chunks append into one paragraph and preserve line breaks; no new paragraph per token/chunk.
- Owned files: `src/ui/desktop/app.js`, `tests/streamedTextRendering.test.js`, and the `package.json` test command.
- Caller: `handleStreamEvent` is called from the existing SSE reader in `app.js`; no server contract changes.
- Focused check: a source-bound regression assertion for one persistent text node plus `node --check src/ui/desktop/app.js`.
- Baseline SHA-256: `54fbe3ea16675a4e48465e321607f2cb0abf462b30ec8d89664b556d541b5604` (`app.js`); `ead2d2b54625a50107ca06049438abf243167e87b5557270ac385a265ae4d74d` (`package.json`).

## Slice 2 result — streamed assistant text

- Each `message_delta` now appends to one persistent paragraph, preserving streamed words and line breaks instead of creating one paragraph per chunk.
- Added `tests/streamedTextRendering.test.js` to `npm test`.
- Checks passed: `node tests/streamedTextRendering.test.js`, `node --check src/ui/desktop/app.js`, `node tests/nativeSessionBridge.test.js`, and `node tests/desktopSessionSearch.test.js`.

## Slice 3 result — Mac speech bridge and honest fallback

- Connected the existing WKWebView `speech` message handler to the microphone UI and wired native results/errors back into the composer.
- Browser SpeechRecognition remains the fallback where the Mac wrapper is absent. Removed the simulated fixed sentence; unsupported runtimes now show a clear message.
- The stop action now stops active browser recognition and the native Speech framework session.
- Added `tests/nativeSpeechBridge.test.js` to `npm test`.
- Checks passed: `node tests/nativeSpeechBridge.test.js`, `node tests/streamedTextRendering.test.js`, `node --check src/ui/desktop/app.js`, `node tests/nativeSessionBridge.test.js`, and `node tests/desktopSessionSearch.test.js`.
- Not tested: macOS microphone/speech permission prompts, actual on-device Korean transcription, app build/install, and full npm test suite.
- Current SHA-256:

```
8a16e8f436b9c380a443aa1db23dbe20fa33ceacbe3a5c3d25f7e6d37a68cd53  src/ui/desktop/app.js
6dfa59004d52fa8a1226dac40220d344ea5fe47dd4f7a685db9512ace1fe7b7c  package.json
6790419261a6590f1aac9c463b48bfbc1fa831deae2996222ba9c1ce59a2f47f  tests/nativeSpeechBridge.test.js
49120246613ed8cbcda191814897f9050a31c663495992d2b313e2b77ff80cf5  tests/streamedTextRendering.test.js
```


### Slice 4 source hashes

```
e69036e633b5359755648bf59942d3f6a9293ad0abf8d25db9225caa61fe26c0  src/morph/SharedStateReplica.js
01ba4d97d09557e0bc17d56bbfa53e40cd0071c7c22a5759ca15820144a65907  tests/sharedStateReplica.test.js
440605d8151ac80ebc8e5d17df40c8c2986dc298da192782e08b1bc8c01941a6  src/ui/desktop/server.js
b565bf4fa74d6abd4848e8891041af482952fc89ecd3d56cf3847a3d76439440  tests/desktopServerSecurity.test.js
57bc31b35044564a869ccf28f2e927f661e7427995fd8073fcd1c0ba3b1fa3b9  tests/isolatedRuntime.test.js
af424f482649072d5e43c15420b35967482473c6e769c478bfcc613bf611fa1c  package.json
```

## Slice 5 — Windows EvolutionRelay transport source port

- Read the Windows `EVOLUTION_RELAY_CONTRACT.md` and ported its bounded immutable packet/blob transport to `src/sync/EvolutionRelay.js` with its 15-case fixture test in `tests/evolutionRelay.test.js`.
- Integrated the focused fixture into the default `npm test` command. The test verifies hash-addressed packets, base-hash conflicts, no source-only ACK, verified loaded hashes, rollback, stop fencing, serialization, core-file metadata-only packets, busy deferral, timeout, concurrent edits, and symlink refusal.
- Tightened ACK readback so unexpected/missing loaded hash entries cannot count as runtime confirmation.
- Focused check passed: `node --check src/sync/EvolutionRelay.js && node tests/evolutionRelay.test.js` (15 cases).
- Not integrated into Only Chat app/server/renderer. Mac source has none of the six Windows `v1.mjs` module paths or a matching runtime loader. No settings UI integration, shared-folder configuration, Drive read-after-write, Windows receiver ACK, build, install or app-runtime sync is claimed.
- Current source is an Antigravity scratch tree without Git metadata; changes are tracked by execution card and hashes, not commit.

Hashes:

```
e3210cce15e680529a02658c5cb1abbc21fc20204a35e05b742ee730e134a556  src/sync/EvolutionRelay.js
8e30dc49b4944ae0c36fa72d2a736fc2e6d794c6ec41e694dee2f1d9f3cd02a9  tests/evolutionRelay.test.js
```

## QA continuation — dark-mode session sidebar visibility — 2026-10-28

- Owner: current Codex task `01a1827b-5fd2-77a1-b950-2ff02b7ea0bc`; user-authorized Windows handoff integration and direct app QA.
- Live Mac app/server: PIDs `34101` / `34132`, package 1.0.1. Current screenshot showed a blank-looking Pinned/Projects/Recents sidebar; read-only `/api/sessions` returns 9 projects and 200 recents.
- Root cause found in `src/ui/desktop/app.css`: `.nav-item` forces `#27272a`, while the active Mac dark-mode sidebar is `#252527`; real session and project titles become almost invisible.
- Planned slice: replace the hardcoded foreground with the existing `--text-main` token and add one focused CSS regression assertion in `tests/sessionSidebarTheme.test.js`, wired into `package.json`. No history, session, setting, credential, or provider data is changed.
- Focused check: `node tests/sessionSidebarTheme.test.js`. Runtime source/API and visible app must be checked after change; CUA currently reads Only Chat but input returns `-10005 noWindowsAvailable`. Do not claim the live WebView applied the CSS until it is reloaded and the list is visible.
- Baseline SHA-256: `src/ui/desktop/app.css` `c72451848b74e5e52c4d7e7f680b45926cae47becab09bca8f3743b035ea4bb5`; `package.json` `12ce769796bd973c874f5e923335e58496b7fc661acd38897d87288fb650c16a`.

- Result: found an additional startup bug in `src/ui/desktop/app.js`: `loadSessions()` rendered the list, then the trailing `startNewSession()` cleared the composer/timeline but never touched the sidebar. Reordered initialization so a new blank chat starts before async session loading; session data remains intact.
- Also changed startup to begin `loadSessions()` before firing status/vault/connector refreshes so unrelated setup cannot block the list. Theme token fix in `app.css` retained.
- Runtime UI check: source server on port 8899 is still bound to the existing Only Chat process (PID 89691, server PID 89715), so current screenshot is served from the old app session; installed bundle has no embedded source code. The UI currently has unsent composer text. Accessibility click on the supposed titlebar close (AX element 108) invoked the embedded browser drawer instead; no app quit endpoint exists. To avoid dropping the text, did not send signals/quit or force reload. This means updated source was not live-applied or visually verified yet.
- `node --check src/ui/desktop/app.js`, focused sidebar check, and the full `npm test` suite passed (19 suites). Live `/api/sessions` readback: 9 projects, 200 recents. Filter/search button and settings open/return paths are wired; settings stage opened and returned successfully. Browser was not navigated and credentials/providers untouched.
- Post-edit SHA-256:
  `src/ui/desktop/app.js` `68aec1cd3ab2aec31cf88425ce6db8149fe25477b5b6430f0a105e8a5460e0aa`
  `src/ui/desktop/app.css` `57f28dd1ba8c969ef19d65418b462a39b05bc0da3f901ba19b962023431a5d24`
  `src/ui/desktop/index.html` `21d9c99724fb242bb4361f88449f725da001318a7625763e21966084454e5593`
  `tests/sessionSidebarTheme.test.js` `31d32a6b6cd2f5a86cfa21d78ee0377d948066ddc710548ed08dbc96423b7295`
  `package.json` `bddae734e60c208511287d58392937551796ddcb4273a73f00dabcafd40a9830`

## Continuation — rail shortcuts and live application check — 2026-10-28

- Source already has listeners for Home, Projects and History; the focused source test and all 19 `npm test` suites pass again.
- The current app process still serves the updated `app.js` from the canonical scratch source at port 8899. The visible app remains on the home screen with an empty composer. CUA clicks and Cmd+Q did not close/reload the renderer; process identity is a pre-existing user-owned OnlyChat app (`25272`) and its Node server child (`25289`). No signal or forced termination was sent.
- Result: the new navigation source is present and tested, but the running renderer did not provide a visible scroll/section-change readback. Runtime application of this slice remains unverified; preserve the app and its session data.

## Continuation — route Only Chat browser launches through 3F — 2026-10-29

- Owner: current Codex task `01a18319-f286-7422-a30c-be3e0e726b89`; task record `onlychat-3f-browser-routing-20261029`.
- Current Mac source remains `/Users/rogan/.gemini/antigravity/scratch/my-codex` with no Git metadata. Existing Only Chat PID `52674` and 3F Browser PID `88092` were observed running. Neither process was restarted or navigated during this source check.
- `DesktopServer` now routes macOS agent browser open/navigation tools through a `ThreefBrowserBridge`, which issues the registered `threef://open` URL. Focus Fence is checked before dispatch; invalid schemes and URLs containing credentials are rejected.
- The default Only Chat browser drawer “이동” action now calls the 3F handoff endpoint. Its labels identify 3F Browser. Page ARIA/read/action methods explicitly report that no 3F page-control bridge exists yet; no false control success is returned.
- Added `tests/threefBrowserBridge.test.js`; added both bridge and handoff tests to `npm test`. Full suite completed with exit code 0; `node --check` for bridge/server/renderer and JSON package parse passed.
- Installed `/Users/rogan/Applications/3F Browser.app` was verified with `workflow-control verify-mac` and `codesign --verify --deep --strict`; bundle ID `com.rogan.threef.browser` registers URL scheme `threef`. This verifies the installed opener target, not that this modified Only Chat source is live.
- Only Chat and 3F were already running, so no app/window reload, install, or live page navigation was attempted. This change is source + tests only; installed Only Chat/browser-control runtime remains unverified. The next implementation step is a bounded 3F page-control channel (status, accessibility/read, actions) with request authentication, Focus Fence rechecks, and safe lifecycle; until then Only Chat can open 3F but cannot operate its page.
- Post-edit SHA-256:

```
b8389470cb564df75cfce04b532c0121ea6c03f79ae3a8df3bd00c60751772a8  src/browser/ThreefBrowserBridge.js
8f63741efdeb18dbc3848279c45471ef23004409214a17f5fd14e2695a82dd8b  src/ui/desktop/server.js
733a81cdccb6ca4a3b7a585c481d483c8eca86e9ae8353c98cf5374dc7e01f92  src/ui/desktop/app.js
36cd69230bc83a3c8fc47b78c2c3d6863a7144c655233f4c09643ce6e688d1a1  src/ui/desktop/index.html
6f9e311e34590167615c56b06754348dd5ac437a5dbde68f5d6c04f7c4802f0a  tests/threefBrowserBridge.test.js
d628242de44612272d9fee6aee75ed6a80337732f017a4699507085dec2b9b11  tests/threefBrowserHandoff.test.js
20342a64c57d4a8e3c098ece388fbc3c3a3bdedaf98415913c812254bf1096f8  package.json
```

## Continuation — authenticated 3F page-control channel — 2026-10-29

### Source reconciliation correction — Windows 3F packet verified — 2026-10-29

- Retrieved the Drive handoff `3F-Mac-Handoff-20261029.md` (Drive ID `1kHqPheZm-eOv2S1geBt2BUKNwLX540Sn`) and the actual archive `3F-Mac-Source-20261029-v5-search-customization.zip` (Drive ID `1EXXoBOLGilZMuI2Nk2WMnxaz46x2_fsm`, 1,310,544 bytes). The archive SHA-256 is `8d63e565180df0b06f2cc3970d8d6c4d49bc30db87427bfbf3d1a3f4903b46df`.
- Archive inventory confirms this is the Windows 3F source packet: `.NET 8 WinForms`, `CefSharp.WinForms.NETCore 154.0.340`, and C# browser-shell, search, extension, FocusFense, library, and `ThreeFControlServer` modules. It is not a Mac source archive. The extracted audit copy was temporary and removed after inspection.
- The Windows/CefSharp implementation is source reference for 3F behavior; CEF is not the 3F product identity. Per the handoff, Mac should preserve separate native source/profile and port supported behavior to the existing native Mac browser engine. Chrome extension parity is not established by the archive and must not be claimed for WKWebView.
- This evidence supersedes the earlier assumption that the locally built SwiftUI/WKWebView app plus its loopback API was reconciled with the Windows packet. Those Mac changes remain source/candidate work only; they are not yet integrated into Only Chat's in-window browser surface and must not be treated as the requested finished browser integration.
- Current process boundary remains: do not restart or navigate the active Only Chat/3F sessions for validation. The exact archive was received from Drive and its inventory/hash verified; no Windows machine was probed.
- Next: map the verified Windows module contracts to the actual Only Chat macOS in-window browser surface and existing 3F Mac source, preserve the policy boundary, identify compatible extension scope, then implement and verify one integrated slice. Keep runtime verification pending until it can be done without disturbing active sessions.

### In-app browser panel slice — 2026-10-29

- The installed Mac Only Chat shell is AppKit + WKWebView (`macOS/OnlyChatApp.swift`); its existing drawer had been sending navigation to the standalone 3F app. The drawer now contains a native WKWebView child view positioned over its browser surface, so user navigation stays in the Only Chat window. The standalone 3F launch remains an explicitly separate button.
- Added address/search resolution: URLs/domains navigate directly, ordinary text searches Google, and `file:`, `javascript:`, credential-bearing and other non-HTTP(S) explicit URLs are rejected. Back/forward/reload, text read, and accessibility capture target the in-app page.
- Native browser top-level navigation asks Only Chat's `FocusFencePolicy` endpoint for approval; denied or unavailable policy fails closed and displays a block page. The endpoint is disabled in isolated mode.
- Source changes: `macOS/OnlyChatApp.swift`, `src/ui/desktop/server.js`, `src/ui/desktop/app.js`, `src/ui/desktop/browser-address.js`, `src/ui/desktop/index.html`, `tests/browserAddress.test.js`, `tests/threefBrowserHandoff.test.js`, `package.json`.
- Validation: `npm test` exit 0 including address/search, Focus Fence authorize/deny, isolated-mode rejection and all existing suites. Swift AppKit/WebKit compile succeeded. Final signed candidate `.build/Only Chat.browser-panel-r2.app` passed deep/strict codesign and `workflow-control verify-mac`; bundle ID `com.rogan.onlychat`, version `1.0.1`, executable SHA-256 `db3fdcdebc87935bb49b8a0752199b45efcbf2bc45a031c6293e4b48825ce5a4`.
- Runtime remains unverified: existing Only Chat PID `52674` and 3F PID `88092` remained active. Candidate was not installed/launched; neither active app was restarted or navigated.
- Remaining integration: AI browser tool calls still use the existing `ThreefBrowserBridge` to control the separate 3F app when its control endpoint is available; unify those calls with this in-app WKWebView next. This WKWebView engine does not support Chrome extensions, and the embedded view's persistent browser profile/extension compatibility has not been established. Do not claim full 3F, Chrome-extension, or Antigravity parity from this slice.
- A follow-up coordinate correction rebuilt the candidate as `r2`; the superseded `.build/Only Chat.browser-panel.app` binary had no open executable handle and was removed. Only the final review candidate remains; it has not been installed or launched.

- Owner: current Codex task `01a18319-f286-7422-a30c-be3e0e726b89`; shared task `3f-onlychat-control-channel-20261029`.
- 3F canonical source base is `main@5de4561`. Added a loopback-only `NWListener` API with a per-launch 96-hex token in `~/Library/Application Support/3F Browser/only-chat-control.json` (directory 0700, descriptor 0600); descriptor is removed on graceful app termination. Only Chat reads a regular, owner-owned, private descriptor and uses bearer authentication.
- 3F exposes status, HTTPS/HTTP navigation, bounded accessibility tree/text reads, and element-ID click/type/fill operations. It accepts only HTTP/1.1, caps the body at 16 KiB, rejects duplicate/transfer-encoded headers and unknown routes, and binds specifically to `127.0.0.1`.
- Only Chat uses the 3F control API when the descriptor is live; without it, it falls back to the registered `threef://open` handoff. It rechecks Focus Fence before navigation and before page reads/actions. A not-ready first WebView falls back to opening the 3F URL. Unknown/missing descriptor remains unavailable; page control does not claim success.
- Verification: Swift suite 11/11; Only Chat `npm test` exit 0; Node syntax and focused handoff tests passed. Release build SHA-256 `9803ced7f8062f04d8b1c0619a08eaf1409fdaea360a8157a2e1477c2989c459`. Rebuilt `.build/windows-handoff-candidate/3F Browser.app`; `workflow-control verify-mac`, deep/strict `codesign`, Info.plist, bundle ID, `threef` scheme, and identical source/bundle ICNS SHA-256 passed.
- Runtime limit: installed Only Chat PID `52674` and installed 3F PID `88092` were already active. No app was restarted, installed candidate or user page navigated, or user session changed. The live descriptor was absent; consequently page control is candidate/source evidence only, not installed runtime proof.
- Integration limit: current source tree has exactly the four files below modified/untracked. Git integration was blocked by active repository edit lease `39cfb694` for `3f-windows-handoff-mac-port-20261029` (paths do not overlap); the integrate claim was rejected by the lease tool. Do not bypass that lease. Changes are preserved in place for later integration.
- 3F source hashes:

```
7202c8db4e5691da783ce583ede97abfee64158f41c116f5c668e8a4e479f446  Sources/ThreeFBrowser/ThreeFBrowserControl.swift
728f173dbde67dbdfb632bdec943286e483c9f67dbe3ce1186e2d5c7d14ab4b8  Sources/ThreeFBrowser/ThreeFBrowserApp.swift
ca29870bcf241abcdc00a5c7c17aca450d946be6a998976616571e21226e6b7b  Sources/ThreeFBrowser/BrowserView.swift
489ab44956b6f4e7f452ea7a29b1869adac8b7732518ce1c55c0b985f0b2b056  Tests/ThreeFBrowserTests/ThreeFBrowserControlTests.swift
```
- Only Chat bridge/UI hashes:

```
845e18526ecbb6d19354f9e6b92d4aacbd8702a1334bedae8895f61acdceac56  src/browser/ThreefBrowserBridge.js
8f63741efdeb18dbc3848279c45471ef23004409214a17f5fd14e2695a82dd8b  src/ui/desktop/server.js
733a81cdccb6ca4a3b7a585c481d483c8eca86e9ae8353c98cf5374dc7e01f92  src/ui/desktop/app.js
c0a28eb56a0932db0ba0cc853cccb3b133b021a867aad6320e6958e625b1aa7b  src/ui/desktop/index.html
90804ae4330a8ac98e6d15d6e75921f215fbb93ce9cf9d0473e16532f015f444  tests/threefBrowserBridge.test.js
d628242de44612272d9fee6aee75ed6a80337732f017a4699507085dec2b9b11  tests/threefBrowserHandoff.test.js
```

## Continuation — route Only Chat browser panel to the actual 3F session — 2026-10-29

- User correction confirmed: 3F Browser is the product. The Drive packet is Windows 3F source using CefSharp internally; CefSharp is not the product identity. The installed Mac `3F Browser.app` links WebKit. The old `Application Support/3F Browser/CEF/User Data` directory alone was not evidence of the active engine.
- Found a live-source mismatch: Only Chat AI browser tools used `ThreefBrowserBridge`, but drawer URL navigation, ARIA/text read and history controls used a separate WKWebView. Changed the drawer to dispatch navigation/read/ARIA/history to the same authenticated 3F Browser API used by AI tools. Added `/api/browser/read` and `/api/browser/history`; history target URLs are checked with Focus Fence before the authenticated 3F history action. The drawer now states that the web page is shown in the 3F Browser window and the controls use that same session.
- Added coverage for authenticated back/reload, unavailable forward history, Focus Fence denial before history requests, the new read/history routes, and isolated-mode blocking.
- Checks: Only Chat `npm test` completed with all configured suites passing; focused `node --check` and 3F bridge/handoff tests passed. 3F Mac `swift test` passed 11/11. Rebuilt `.build/windows-handoff-candidate/3F Browser.app`; deep/strict code signature and `workflow-control verify-mac` passed; executable SHA-256 `d94f82a7131e08bce23dcfa56ba67ec8f1898f992af0f814c01d65af5dfcab7e`.
- Runtime boundary: installed Only Chat PID 52674 and installed 3F PID 88092 remain active. The installed 3F bundle is older than the candidate and has no `only-chat-control.json` descriptor; its live control API is therefore unverified/unavailable. Neither app was restarted, reinstalled, or navigated. Candidate installation and live UI/API proof remain pending.
- This does not establish full 3F parity, Chrome extension compatibility, or Antigravity/ChatGPT equivalence. Keep the overall objective active.
