# 3F Browser isolated runtime follow-up — 2026-10-31 KST

## Scope

Tested a temporary copy of the installed `/Users/rogan/Applications/3F Browser.app` executable under bundle ID `com.rogan.threef.browser.qa.onlychat20261031`. The copy was ad-hoc signed, passed strict `codesign --verify --deep --strict`, and `workflow-control verify-mac` returned `state=verified`, `launchAllowed=true`, `mode=local_dev`. A temporary control descriptor isolated the QA listener. This bundle ID isolates UserDefaults and WebKit website data from the installed app's bundle ID; the original installed app was not launched or modified.

Only Chat source bridge: `/Users/rogan/.gemini/antigravity/scratch/my-codex/src/browser/ThreefBrowserBridge.js` with `FocusFencePolicy.js`.

## Observed results

- Authenticated 3F `/v1/status`: HTTP 200.
- Focus Fence policy for `https://example.com/`: allowed.
- `https://example.com/`: navigation reported success; status URL and title read back; body text 156 chars; ARIA text 157 chars; QA process alive.
- `https://example.org/`: navigation reported success; status URL and title read back; body text 917 chars; ARIA text 943 chars; QA process alive.
- 3F QA process remained alive after both page reads. No matching fault/error/termination lines were captured in its temporary stdout/stderr log.
- Only Chat bridge `history("back")` and `history("forward")` did not both return success; history navigation is not certified by this run. An existing earlier isolated current-source E2E recorded successful back/forward, so the evidence differs by build/profile and needs reconciliation.
- QA temporary directory, app copy, WebKit profile, descriptor and log were removed. Follow-up process listing found no QA bundle process. The installed user bundle and its data were not modified.

## Limits and next action

This proves the installed executable can stay alive and serve two safe pages when copied under a unique QA bundle ID. It does not prove the original installed bundle's lifecycle, installed Only Chat's current runtime, Focus Fence denial behavior in 3F, or Windows receiver application/build/install/runtime. Do not replace installed app or restart Only Chat from this result. Next inspect history response/status ordering and compare launch context for original bundle before another runtime attempt; Windows remains unknown and no remote probe is allowed.
