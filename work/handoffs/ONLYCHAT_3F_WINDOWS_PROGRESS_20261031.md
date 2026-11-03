# Only Chat / 3F Browser progress handoff — 2026-10-31 (KST)

## Current Mac evidence

- Canonical 3F Browser source: `/Users/rogan/appDev/apps/3f-browser-mac`, branch `main`, base HEAD `5eaaee0`; the 13 existing dirty/untracked paths were preserved.
- Installed `/Users/rogan/Applications/3F Browser.app` from current source as bundle `com.rogan.threef.browser`, version `0.1.0+2`. Executable SHA-256: `a8f414bd168f448296200f33b5a5ea3aa7794a9f03a0fb1368cb17a9733de001`. Strict codesign and `workflow-control verify-mac` passed (`local_dev`, launchAllowed=true).
- Existing isolated full E2E evidence (2026-10-30 23:50 KST): current-source Only Chat `ThreefBrowserBridge` connected to a separately built 3F QA app with authenticated loopback API; opened `example.com` and `example.org`, read each page title/body (917 chars) and ARIA (943 chars), then back/forward; final URL readback was `https://example.org/`. Entire Swift suite passed 24/24. Production user profile and installed Only Chat were not used.
- The newly installed production-identity 3F bundle has not yet passed a stable repeated live session. Prior isolated attempts intermittently lost the app/control listener; current check finds no 3F process and Focus Fence `127.0.0.1:17361/health` is not responding. This is an open runtime blocker, not a completed 3F release.
- Installed Only Chat remains an older live process (PID 4031; server PID 4071 on :8899) with an unsent user draft. It was not restarted. Its status is not proof that the latest source is active.

## Windows handoff / remaining receiver work

- Windows availability is expired/unknown. No remote probe or edit was made. No verified current Windows source checkout or receiver ACK is available from this Mac, so Windows source application, tests/build, installation, and visible runtime remain unverified.
- On an available Windows session: first read the actual checkout version, dirty state, and active owner; preserve Windows provider/browser architecture; apply compatible control status and keyboard behavior; validate safe navigation, URL/title/text/ARIA readback, back/forward, Focus Fence blocked/unavailable cases, and tool/progress UI. Send source/build/install/runtime evidence and receiver ACK back through this Drive folder.
- Handoff publication is communication only. It does not prove Windows has read or applied the changes.

## Next Mac actions

1. Diagnose why the installed production 3F app/control listener is intermittent, then repeat status → safe navigation → text/ARIA → history in an isolated profile without touching the user's browser profile.
2. Verify live Focus Fence policy/service behavior, including a denied destination in a safe isolated test.
3. Keep the Only Chat installed process and user draft intact until a safe session handoff permits updating it; then verify current source actually loads and the 3F status cannot show a false connected state.
4. Continue the open Only Chat roadmap, including work progress display, schedules, tool execution proof, and 35Closer approval integration.

## Latest installed-bundle probe (2026-10-31 KST)

- Verified that the exact installed binary in an isolated temporary HOME publishes a private loopback descriptor and returns authenticated `/v1/status` HTTP 200 (`about:blank`). Focus Fence `/rules?browser=3f` was HTTP 200 at the same check.
- The installed bundle accepted `POST /v1/navigate` for `https://example.com/` with HTTP 200, but its control listener then disappeared before status/title/text/ARIA readback. The page load and subsequent history were therefore not proven. The temporary HOME/profile was cleaned up; no production browser profile was opened or changed.
- This narrows the production-bundle failure: it is not explained by a missing Focus Fence rules endpoint in this probe. The app's post-navigation process/control-server exit still needs a diagnostic cause and a repeatable fix. Do not report 3F production runtime complete yet.
- Fresh validation at 00:17 KST: guarded `swift test` on the current 3F checkout passed 24/24 (0 failures). This confirms source tests, not the failed installed-app navigation runtime probe above.

## Only Chat work-progress evidence (2026-10-31 KST)

- In a disposable workspace, the current Only Chat `CodexCliAdapter.call` invoked GPT-6 Luna at low effort for one read-only `exec_command` (`cat fixture.txt`). The adapter emitted one tool-start and one tool-end event with exit code 0; the response contained the fixture value and the fixture remained unchanged. End-to-end adapter round trip was 11 seconds.
- Re-ran `node tests/assistantWorkProgress.test.js` and `node --check src/ui/desktop/app.js`; both passed. The renderer test confirms tool steps remain visible while active, reasoning text is omitted, and details collapse at completion with elapsed time retained.
- Boundary: the live installed Only Chat UI/API stream was not restarted or exercised because its active session contains an unsent draft. Thus the actual renderer card, elapsed timer, and Windows receiver display remain pending. The Windows handoff contains this evidence for later selective application; it is not receiver acknowledgement.
