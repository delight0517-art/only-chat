# Only Chat Windows Progress Update — 2026-10-31 KST

## Mac source/UI result

- Fixed the schedule manager stale-editor state in `src/ui/desktop/app.js`: after a successful list refresh, an editor is cleared only if its selected schedule no longer exists.
- Verified the actual UI flow in a fresh isolated Only Chat renderer whose `/app.js` SHA-256 matched the current source (`43a1b6d68f642094a42ff1bc5964688bf034f134c3afa46cd8a7de6a09578326`). A disposable disabled schedule was selected, deleted through the isolated API, then the UI's `목록 새로고침` button was pressed. The list became empty, title/request fields cleared, and Delete/Run controls disappeared.
- Focused `node --check` passed. This proves the isolated Mac candidate UI, not the installed production app.
- Selective Windows patch: [OnlyChat_Schedule_Editor_Fix_20261031.patch](https://drive.google.com/file/d/1dq7VTa-o1bHc7BouWZWsQ17co48jIX2C/view)
- Patch instructions and Mac proof: [OnlyChat_Schedule_Editor_Fix_20261031_README.txt](https://drive.google.com/file/d/1D5h4l52Rx7Gb6ZVNuQmaEV51KtrRe5ey/view)

## 3F Browser status

- An isolated current-source Mac E2E previously connected Only Chat's actual bridge to a disposable 3F Browser candidate: safe example.com/example.org navigation, URL/title, page text, ARIA and back/forward were read back.
- New isolated follow-up used a copy of the installed 3F Browser executable under unique bundle ID `com.rogan.threef.browser.qa.onlychat20261031`, with an isolated control descriptor and the current Only Chat bridge. Authenticated status returned HTTP 200; actual page title, body and ARIA were read on example.com and example.org, and the process remained alive. This proves the installed executable can stay alive as an isolated renamed-bundle copy; it does not prove the original installed bundle launch lifetime.
- Back/forward did not both return success in this latest run. Existing earlier E2E and this result differ, so history remains open pending reconciliation. Focus Fence policy allowed example.com; block-denial runtime remains unverified.
- The isolated app copy, WebKit profile, descriptor and logs were removed after the test. The installed 3F app and Only Chat user session/draft were not changed. Evidence: `work/onlychat-3f-runtime-isolated-qa-20261031.md`.
- Installed production Only Chat runtime is stale (`/api/schedules` and `/api/browser/threef/settings` are 404 on its current server); its user draft was preserved and it was not restarted.
- Existing Windows implementation guide: [3F-Windows-Parity-20261030.md](https://drive.google.com/file/d/1bRf8huyX23KoRiAGCagrwk6k7TgW97SY/view)
- Existing cross-app handoff: [ONLYCHAT_3F_BROWSER_WINDOWS_PROGRESS_20261030.md](https://drive.google.com/file/d/1seykmT-yZfCsBPIGKBxiSCHy8LkXYv-A/view)

## Windows receiver steps

1. Read the actual Windows checkout version, dirty files, and active session before applying anything. The available Drive archive is a snapshot and does not prove the live checkout.
2. Apply the schedule patch selectively to the matching Windows source; resolve context rather than overwriting unrelated files.
3. Port the 3F bridge behavior using the Windows app's own browser/control architecture and preserve Focus Fence fail-closed policy.
4. Verify build, installation, connected 3F status, safe URL navigation, text/ARIA, history, blocked destination, and offline error separately.
5. Send a receiver acknowledgement with source revision, build/install version, and visible runtime evidence. Until then, Windows application/build/install/runtime remain pending.

Windows availability is currently unknown. No Windows remote probe or action was performed in this update.

## 3F Browser — latest Mac installation result (2026-10-31 KST)

- The 3F Browser model-route change was built and installed on Mac. Installed executable SHA-256: `e987b3d9d89c4b5f33120d885046cb80b38cfb8e3fa67c78519e562f52ee536a`. Strict code-signature and local execution-policy checks passed. A fresh temporary HOME received an authenticated `/v1/status` HTTP 200 at startup; the existing user browser profile was not used. The previous installed build remains available as the rollback candidate.
- A full isolated current-source run with Only Chat's actual bridge passed safe-site navigation, page text/ARIA readback, and back/forward. This is isolated-candidate evidence.
- The installed original-bundle lifetime is still failing before feature verification: in LaunchServices normal-window mode with no navigation, `/v1/status` was HTTP 200 at about 0.5 seconds, but the app process and control listener were gone by about 1.1 seconds. A direct launch also received `SIGTERM` within about one second. The app's captured stdout/stderr and recent matching crash/log records were empty; termination source and root cause are unresolved. Earlier navigation-followed-by-disconnect observations do not establish navigation as the cause. Do not report installed 3F control complete from the isolated run.
- The Mac-specific SwiftUI fix cannot be copied as-is into Windows. Port its behavior into Windows' existing browser/control implementation after reading that machine's live source version and dirty state. Preserve Focus Fence fail-closed checks. Required receiver proof: connected status, two safe navigations with text/ARIA readback, back/forward, a configured blocked destination, and offline failure handling.

## Windows receiver state

Windows availability is unknown/expired. No remote probe, source change, build, install, or runtime check was performed. Apply the existing schedule and work-progress patches only after confirming their exact baseline match; then implement the browser control behavior in Windows' own architecture and return receiver ACK with exact source/build/install/runtime evidence. Drive readback confirms this handoff document only; it does not prove Windows applied it.

## Windows integrated progress + 3F browser history delivery — 2026-10-31 KST

A single selective patch now combines the user-readable live work steps/elapsed-time display with Windows Electron 3F browser back/forward/reload controls. History targets are checked against the existing Focus Fence policy before moving. The integrated patch was applied to a fresh copy of the exact Windows 1.0.5 source snapshot; `assistantWorkProgress.test.js`, `embeddedBrowser.test.js`, changed JavaScript syntax checks, and a focused history/blocked-destination behavior check passed. The isolated tests passed on the source snapshot, not on Windows.

Use this integrated Drive package only; it avoids the app.js overlap between the separate earlier patches:
- Patch: https://drive.google.com/file/d/1P4fC0QrlEso3a-tX9axnajv0IH9jKS3r/view
- Apply/validation guide: https://drive.google.com/file/d/1K4opbM6D_ouJ8rz5HD4PR4ZDmCYH1dBb/view
- Patch SHA-256: `a71b6922a7c83b1bdd67c1d326724909a56bdd41aa8ea3cdf05a6a9fff8c04b8`

Windows availability and live checkout are unknown. Receiver source application, build, installation, app runtime, connected 3F page control, and ACK remain pending. The Mac installed original 3F bundle also still exits shortly after launch; this patch does not resolve that Mac runtime blocker.
