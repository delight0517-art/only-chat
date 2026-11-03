# Only Chat Windows work progress and 3F browser history patch — 2026-10-31

This integrated selective patch combines the visible assistant work-step/elapsed-time UI with Windows Electron 3F browser history controls (back, forward, reload). Before any history move or reload, the existing Focus Fence policy checks the destination; denied or unavailable policy results leave navigation blocked.

## Exact baseline

- `OnlyChat_Windows_Source_Current.zip`, Drive ID `1K9ETorgnTXyg5yZdfVtxTdLT2fl-FeJV`
- SHA-256 `04000fb805bcf12c5aba5d30371a69a67408188b139ee96ff14f1ac3616b28e0`
- Snapshot package version `1.0.5`; this does not identify the live Windows checkout.

## Apply

Confirm the actual Windows source version, dirty files, and active session first. The patch is rooted at the archive's parent folder (`OnlyChat-Windows/...`). From that parent, run `git apply --check <patch>` then `git apply <patch>`; do not separately apply the older work-progress or history patches when using this integrated patch.

## Validation on Mac snapshot

- Clean `git apply --check` and actual application on a fresh extraction.
- `node --check` passed for changed JavaScript.
- `assistantWorkProgress.test.js` passed: live tool step display, reasoning not exposed, completed details collapse.
- `embeddedBrowser.test.js` passed.
- Separate isolated browser behavior check passed back, forward, reload, and Focus Fence denial while keeping the current page.

Windows receiver application, build, install, live 3F connection, and runtime proof remain pending. Receiver acknowledgement should identify the actual source revision, build/install version, connected status, page text/ARIA, back/forward, Focus Fence denial, and offline-policy behavior.

## Mac 3F runtime follow-up — 2026-10-31

- Installed 3F Browser reports version `0.1.0` build `2`; local signature verification and `workflow-control verify-mac` passed.
- A launch attempt did not leave the 3F Browser process running, and the descriptor's loopback port had no listener, so Only Chat did not have a live 3F control connection to verify. No new 3F crash report was found.
- Installed Only Chat is older than the current source: its `/api/browser/threef/settings` route returns 404, and its browser status text is the old embedded-panel message. Current source defines the external 3F settings route, but the existing app session remains untouched because it contains a user draft.
- The 3F repository has active CEF `cefsimple` processes using its existing `.build` tree, so this pass did not build or run tests there.
- Actual Only Chat dispatcher/provider smoke (2026-10-31): on a separate temporary DesktopServer profile/workspace, priority resolved past exhausted Tier 1 (0%) and disconnected Tier 2 to Tier 3 `codex-primary`, GPT-6 Luna. The real Codex adapter ran one `exec_command` successfully (exit 0); dispatcher recorded `completed` with 1 attempted / 1 successful / 0 failed and provider/model/tier metadata. The generated file contents and JS syntax were independently checked, then the temp profile/workspace were removed. This verifies the current Mac source path, not the stale installed app or Windows receiver.
- Windows remains a prepared Drive handoff only. Receiver-side source application, build, install, live 3F connection, and ACK are still pending; no Windows machine probe was made.
