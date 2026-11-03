# Only Chat Windows 3F browser history patch — 2026-10-31

This selective patch adds browser back, forward, and reload controls to the Windows Electron embedded browser. Each history destination is checked through the existing Focus Fence policy before Electron moves to it. A blocked or unavailable policy keeps the current page in place.

## Baseline

- Source archive: `OnlyChat_Windows_Source_Current.zip`
- Drive file ID: `1K9ETorgnTXyg5yZdfVtxTdLT2fl-FeJV`
- Baseline archive SHA-256: `04000fb805bcf12c5aba5d30371a69a67408188b139ee96ff14f1ac3616b28e0`
- Snapshot package version: `1.0.5`; this is a Drive snapshot, not proof of the live Windows checkout.

## Patch

- `OnlyChat_Windows_v1.0.5_3F_Browser_History_20261031.patch`
- SHA-256: `2559bb4fb2b134e0135e218c22b5e158ede2fa106b3a7bb4a959ba1a659e0d21`
- Apply from the archive's `OnlyChat-Windows` root after confirming the live checkout still matches the baseline and has no conflicting edits: `git apply --check <patch>` followed by `git apply <patch>`.

## Mac-side validation against the snapshot

- Patch applies cleanly to a fresh extraction of the baseline ZIP.
- Existing `tests/embeddedBrowser.test.js` passes.
- JavaScript syntax checks pass for changed JavaScript files.
- A temporary behavior check passed back, forward, reload, and Focus Fence denial without leaving the current page.
- UI route and control presence checks pass.

Windows receiver application, native build, installation, and runtime are pending. Do not treat this Drive handoff as Windows completion. Required receiver proof includes the actual source revision, build/install version, safe navigation and history, Focus Fence blocked navigation, and offline-policy behavior.
