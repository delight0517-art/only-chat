# Only Chat and 3F Browser — Windows progress handoff

Updated: 2026-10-30 23:17 KST

## Current Mac source change

- Only Chat's `ThreefBrowserBridge` already routes browser navigation, page text/ARIA reads, actions, and history through the standalone 3F Browser control API. It checks Focus Fence before navigation and again before page reads/actions/history.
- A live test found a false-success case: macOS accepted a `threef://open` request and Only Chat returned HTTP 200 even though 3F Browser did not remain running and its control listener did not answer.
- The bridge now polls the authenticated 3F `/v1/status` after a deep-link launch and reports navigation success only after that endpoint reads back the requested URL. If the service/page cannot be verified within five seconds, it returns an explicit failure.
- Focused checks passed on Mac: `threefBrowserBridge.test.js`, `threefBrowserHandoff.test.js`, `threefBrowserControlSettings.test.js`, plus `node --check` for the bridge.
- End-to-end source HTTP check with a temporary profile and an intentionally unavailable 3F endpoint returned HTTP 502 with `ok:false` and an explicit “control service/page not verified” reason. This verifies Only Chat server routing against the new bridge code, not a live 3F app.

## Mac runtime evidence and limits

- An isolated Only Chat runtime on port 18999 used a temporary data directory. Its 3F settings route returned HTTP 200 and enabled the setting. The status route returned `available=true` but `controlAvailable=false`.
- A request for `https://example.com` returned HTTP 200 before the bridge fix. Immediately afterward, no 3F Browser process was running and the existing control descriptor's port had no listener. This shows that launch-request acceptance alone was insufficient proof.
- The installed 3F Browser passes `workflow-control verify-mac` and strict code-signature verification, but the app process does not remain available. The cause is still unknown.
- The Only Chat native `WKWebView` confirmation-sheet change is Mac-specific. Do not copy `macOS/OnlyChatApp.swift` into the Windows Electron app.
- A 3F source lease `607f7294` currently owns three Swift source/test files until its recorded expiry. Native rebuild/retest must wait for its release. The installed Only Chat session and unsent user draft were left untouched.

## Latest cross-check (2026-10-30 23:05 KST)

- The isolated Only Chat schedule QA window at `127.0.0.1:18998` currently exposes the schedule manager modal and a saved, disabled QA schedule in its accessibility tree. This contradicts the earlier checkpoint that the modal never opened; it does not yet prove the full UI save/edit/delete flow or automatic dispatcher execution.
- The installed Only Chat process at `127.0.0.1:8899` still returns HTTP 404 for `/api/schedules`; it remains an older runtime. Its active user session/draft was not touched.
- `workflow-control verify-mac` and strict `codesign --verify --deep --strict` pass for the installed 3F Browser. At this check, no 3F Browser process was running; its authenticated control port therefore had no live consumer. The latest 20-minute process log query and existing DiagnosticReports provided no 3F-specific exit cause.
- A second CLI-only query covered the last 60 minutes and searched Unified Log messages for the 3F bundle identifier/executable name; it returned no matching events. `LSUIElement` and `LSBackgroundOnly` are absent from the installed Info.plist, so the bundle is not configured as a background-only app. This still does not identify why the process exits.
- Lease `607f7294` remains active through 2026-10-30 23:48 KST and owns `BrowserKeyboardCommands.swift`, `ThreeFBrowserApp.swift`, and `BrowserKeyboardCommandsTests.swift`. The 3F Mac build/runtime retry is still deferred until lease release and stable source readback.
- The current Windows source artifact discovered in the shared Drive folder is v1.0.4 (197,810 bytes), dated 2026-10-29, not a verified current Windows checkout. It is a snapshot only; no Windows remote action or receiver application has occurred.

## Windows source and receiver status

- Current Drive listing shows `OnlyChat_Windows_Source_Current.zip` (472,736 bytes, modified 2026-10-27) and archived Windows 1.0.2 artifacts. A prior lookup in this task reported a v1.0.4 archive, but a fresh search/list no longer finds that item. Therefore the current Windows baseline version is unresolved; inspect the receiver checkout before applying any patch and preserve Windows-only provider, Focus Fence, profile, and packaging behavior.
- Windows availability is expired/unknown. No remote probe, source edit, build, install, or runtime check was made.
- This document is a Drive handoff only. It is not evidence that Windows has received or applied the change.

## Only Chat priority runtime cross-check (2026-10-30 23:08 KST)

- The installed Mac `/api/status` reports automatic priority enabled. Tier 1 Antigravity has quota remaining 0 and is not eligible; Tier 2 GPT-6 Luna Secondary is disconnected; Tier 3 GPT-6 Luna Primary is connected and currently active. No email addresses are included in this cross-device handoff.
- Host `node tests/priorityChain.test.js` passed, including a synthetic AgentEngine retry where a Tier 1 quota 429 leads to a Tier 2 response. This proves the current source retry path with the local synthetic adapter, not a real provider response or Windows runtime.
- The Mac live API state is consistent with falling through the exhausted/disconnected first two tiers to the connected third tier. A completed real user chat turn through that live routing path remains unverified.
- For Windows, compare the current account readiness/quota state with the portable tier ordering. Never carry Mac provider readiness as Windows runtime evidence; verify the Windows adapters and selected active tier on that machine separately.

## 35Closer Timer integration (2026-10-30 23:12 KST)

- Only Chat's Codex CLI adapter enables `onlychat_35closer` only on macOS. The connector's sleep/wake tools create user-approval intents; they do not directly change power state.
- Added `timer_status`, a read-only MCP tool in `src/connectors/OnlyChat35CloserMcpServer.js`. Focused connector test and Codex adapter tests pass (1 connector suite, 8 adapter checks). Calling the source connector against the real local CLI returned fresh status in 1.1 seconds, reported 35Closer as policy owner, and confirmed remote power changes are disabled.
- Separate stdio protocol round-trip also passed: MCP initialize, tools/list (7 tools), and tools/call `timer_status` returned fresh status through the actual local 35Closer CLI. Current source SHA-256 values: connector `99350d9989a7e4d4122c998872df2b9f45d3117e33c167f5d2df1e3b9cc7c1a6`; focused test `695ce91ff3b9e22bb6c78769f087aad572cabda43ec31aed5f673b4a5287c54e`.
- 35Closer's current capability manifest marks sleep intent as approval-required and explicitly says the installed Only Chat consumer integration is pending. We did not submit a sleep or wake request. The installed Only Chat app is still an older runtime and has not loaded this source change.
- Windows cannot use this Mac CLI connector: the Only Chat adapter explicitly gates it to `darwin`. Windows needs its own 35Closer-supported client/API and approval path after its actual source baseline is read back. Do not copy the macOS CLI path or treat the Drive handoff as Windows implementation.
- Actual Only Chat provider-path check (23:17 KST): invoked the current connected GPT-6 Luna account at low effort through `CodexCliAdapter.call`, using an isolated QA workspace. Session events show `MCP · onlychat_35closer/timer_status` started and completed; no other tools were called. The model reported `available=true`, `fresh=true`, policy owner `35Closer`, and `remotePowerChangesAllowed=false`. This verifies the source adapter→MCP→local CLI path. The installed Only Chat UI/runtime has not loaded the new tool, and no sleep/wake request or power change was made.

## Windows application steps

1. On the next authorized Windows session, record the actual source version, dirty-file list, active owner, and current build before editing. Compare the current checkout with the dated v1.0.4 package and preserve later edits.
2. Port the bridge behavior using the Windows app's own browser architecture. Keep 3F state and control availability distinct; accepting a deep link must not count as connected or completed work.
3. Return success only after the authenticated control API reports the requested page URL. Preserve fail-closed Focus Fence checks for navigation and page inspection.
4. Verify an approved safe page, text/ARIA readback, back/forward, a Focus Fence-blocked destination, and a disconnected 3F service. Confirm that a disconnected launch stays visibly incomplete rather than “completed.”
5. Record Windows source receipt/application, focused tests/build, installation, and visible runtime as separate stages. Use the existing Windows launcher layout (`run-windows.ps1`, `run-windows.bat`, `app_source/`) and retain Windows provider defaults.

## Related existing Windows handoffs

- [Only Chat dispatcher execution gap](https://drive.google.com/file/d/1HnKBSXrjKHfbGbUU3CRETHOksMZ-Ef47/view?usp=drivesdk)
- [3F Browser parity progress](https://drive.google.com/file/d/1bRf8huyX23KoRiAGCagrwk6k7TgW97SY/view?usp=drivesdk)
- Existing recurring schedule patch: `OnlyChat_Windows_Recurring_Schedules_Patch_20261030.zip`
- Existing Google Workspace MCP reference patch: `OnlyChat_Google_Workspace_MCP_Windows_Reference_20261030.zip`
