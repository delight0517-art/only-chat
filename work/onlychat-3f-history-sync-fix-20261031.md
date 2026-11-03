# 3F Browser navigation/history sync fix — 2026-10-31 KST

## Root cause

The 3F control server loaded a URL directly into `WKWebView`, while the visible SwiftUI browser also owns navigation through `BrowserModel.navigationRequestID`. The two paths could diverge, and a control HTTP 200 only meant that `load()` was called, not that the page loaded.

## Change

The control server now sends approved URLs through the attached `BrowserModel.navigate(to:)` path. This updates the same URL/request state used by the browser UI and lets its `NSViewRepresentable` issue the load once. Focus Fence checks remain before the request and again in the WebKit navigation delegates.

Owned source slice: `Sources/ThreeFBrowser/BrowserView.swift`, `Sources/ThreeFBrowser/ThreeFBrowserApp.swift`, and `Sources/ThreeFBrowser/ThreeFBrowserControl.swift`. The attempted `lastRequestID` counter adjustment was reverted; it is not part of the final fix.

## Verification

- `git diff --check`: passed.
- Full `swift test`: 24 tests passed, 0 failures.
- Release app candidate built at `.build/onlychat-history-fix-candidate/3F Browser.app`.
- Isolated unique-bundle-ID copy passed strict code signature verification and `workflow-control verify-mac` (`local_dev`, launch allowed).
- Actual authenticated 3F control status: HTTP 200.
- Focus Fence policy allowed the two safe sites.
- Only Chat bridge opened `https://example.com/` and `https://example.org/`; status URL and title were read back, body text lengths were 917 and 156, ARIA text length was 157.
- `/v1/status` showed example.org with `backURL=https://example.com/`. Only Chat history back and forward both returned success and status readback confirmed example.com then example.org.
- QA app remained alive through navigation, page reads and history. No matching fault/error/termination lines were captured.
- Test app, descriptor, profile, logs and generated QA preference/WebKit domains were removed. Existing installed app and browser profile were not changed.

## Remaining

The original installed bundle lifecycle and installed Only Chat version are still separate verification steps. Focus Fence denial behavior and Windows receiver application/build/install/runtime/ACK remain open. Do not claim the 3F Browser feature complete until those acceptance gaps are resolved or reported.

## Installed app follow-up — 2026-10-31 KST

- Installed the new source-built bundle at `/Users/rogan/Applications/3F Browser.app`; executable SHA-256 is `e987b3d9d89c4b5f33120d885046cb80b38cfb8e3fa67c78519e562f52ee536a`. Strict code-signature validation and `workflow-control verify-mac` passed. The previous installed executable SHA `a8f414bd168f448296200f33b5a5ea3aa7794a9f03a0fb1368cb17a9733de001` remains as `.build/install-candidate-20261031/3F Browser.app` rollback candidate.
- With a temporary HOME and isolated control descriptor, installed app startup returned authenticated `/v1/status` HTTP 200 (`about:blank`). No existing browser profile was used.
- In follow-up installed-runtime checks, `/v1/navigate` returned HTTP 200 and status/title briefly moved to example.com, but the control listener became unreachable before stable page/read/history evidence. A later idle-only LaunchServices run (no navigation) sharpened the result: authenticated `/v1/status` was HTTP 200 at about 0.5 seconds, then by about 1.1 seconds the app process was gone and its control port refused connections. A direct launch also exited by `SIGTERM` within about one second. Captured stdout/stderr and recent matching crash reports/unified logs were empty, so the termination source and cause remain unknown. This is an app-startup lifetime problem; the earlier timing does not establish navigation as the cause.
- Therefore installed-bundle continuous navigation, page text/ARIA, back/forward, and Focus Fence denial are not verified. The earlier full pass applies only to the isolated QA bundle plus actual Only Chat bridge, not the installed production bundle.
- Windows receiver source application, build, install, runtime, and ACK remain pending. No Windows probe was made.

## Follow-up lifecycle source audit — 2026-10-31 KST

- Canonical source remains dirty on `main`; all pre-existing dirty paths were preserved. `agent-coord status --repo /Users/rogan/appDev/apps/3f-browser-mac` reports no active leases.
- `ThreeFBrowserAppDelegate` retains `ThreeFBrowserControlServer` and the Focus Fence contact task as instance properties; the only matching process shutdown path in the inspected app delegate is `applicationWillTerminate`, where the listener/task/key monitor are cleaned up.
- Installed `Info.plist` identifies a foreground APPL bundle (`com.rogan.threef.browser`) and contains no `LSUIElement` or `LSBackgroundOnly` setting. No 3F process is currently present.
- This source/config review does not explain the observed one-second SIGTERM. No repeat launch was run in this check; the external termination source remains unknown. Do not mark installed 3F runtime complete.
