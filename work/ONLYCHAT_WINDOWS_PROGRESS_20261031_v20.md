# Only Chat Windows receiver progress — v20

Updated: 2026-10-31 KST

## Codex secondary-account connection boundary (2026-10-31 06:49 KST)

- Mac source `/api/priority/connect` saves a tier row; it does not perform Codex CLI login. `CodexCliAdapter` considers a tier connected only when it finds a Codex profile whose account email matches the tier, under `codex-profiles/<tierId>` or the default `~/.codex`.
- Read-only Mac runtime status showed Tier 1 Gemini at 0%/throttled, Tier 2 GPT-6 Luna secondary disconnected, and Tier 3 GPT-6 Luna primary connected/active. The secondary profile has no `auth.json` yet. A separate `CODEX_HOME` login flow was inspected and cancelled before authentication; no login token or device code was saved.
- Do not copy Codex auth profiles between Mac and Windows. Each receiver must authenticate the intended account locally and verify its email match, provider readiness, selected tier, and a real successful request. Windows account readiness is unknown and was not probed.

## Priority-chain live API readback (2026-10-31 06:42 KST)

- Read-only `GET /api/status` returned HTTP 200 with auto priority enabled.
- Tier 1 Gemini was at 0% and throttled; Tier 2 GPT-6 Luna secondary account was disconnected; Tier 3 GPT-6 Luna primary account was connected and selected. The live priority API reports `unknown` quota for the two Codex accounts.
- This confirms the current route selection, not that a new provider request succeeded. The 2nd account must be connected before it can serve as the fallback; do not infer that Windows has the same authentication state.

## 3F / Focus Fence blocker readback (2026-10-31 06:xx KST)

- Focus Fence's read-only SwiftData audit log confirms the 3F browser was intentionally terminated at 05:49:40 KST by build `1.0.6+2026102802`, reason `browser_url_unprotected` (`app-block-instant`): URL/keyword protection had not been verified.
- Current Focus Fence source contains a proposed 3F verified-only fallback exception and an untracked focused policy test, but both are mixed with unrelated dirty changes. A focused test/build attempt did not reach tests because the dirty `VeliMac/VeliMac/Components/BlockActionNoticeBanner.swift:91` has a pre-existing `.padding(.top, 2)` contextual-type compile error.
- No Focus Fence source was edited, built, installed, or restarted; no policy was weakened; 3F was not relaunched. Installed Focus Fence runtime remains older than the proposed source change. End-to-end 3F runtime/navigation is still pending.
- Windows must not apply the policy exception blindly. Its receiver must reconcile its own Focus Fence policy and source ownership first, then verify top-level navigation protection and explicit app-block behavior together.
- Current Mac process readback: Only Chat main app/server and two candidate app/server pairs remain running, plus Focus Fence PID 5860. The live Only Chat draft remains preserved; no process was restarted or terminated.

## New handoff

- Patch: `OnlyChat_Windows_Combined_v1.0.5_20261031_v19.patch`
- Patch SHA-256: `75adf60e3814587f1cf832002368a26c1960282a323196df4ed65148e456a58a`
- Exact expected baseline: `OnlyChat_Windows_Source_Current.zip`, SHA-256 `04000fb805bcf12c5aba5d30371a69a67408188b139ee96ff14f1ac3616b28e0`
- The patch includes prior v18 functionality plus schedule due-time preservation and readable Korean session-search timeout/network errors.
- Receiver-side source application, tests, Windows packaging/build, installation, live runtime, and ACK are not verified. No Windows remote probe was made.

## Mac source evidence

TODO-202 session-search renderer distinguishes HTTP 504 timeout, other HTTP errors, network failures, and stale responses. Focused renderer route/source checks passed. The installed Only Chat app/server remain old and were not restarted because the user draft is being preserved.

## Cross-platform status

Drive upload and server readback prove handoff availability only. Windows receiver must verify its exact source baseline and local edits before applying; if it differs, stop and merge selectively. No receiver state is inferred from the Drive handoff.

## Drive readback

- Patch: `1FUVFCqDJsqcgehaKfe6eJ0ToUeWL6AaL`
- Patch README: `1jR6sKCo4K7byEPhsQCvpb7Xl36VnaB8x`
- Progress record: `1tAkEfDqAIvEnsYaDLTw0itdsPC2rncvE` (updated in place with these IDs)
- Connector readback returned the patch's complete 388,679 bytes; SHA-256 matches the local artifact exactly.
