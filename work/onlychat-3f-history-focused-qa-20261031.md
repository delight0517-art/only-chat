# 3F history focused QA — 2026-10-31 KST

## Scope and safety

Copied the installed 3F Browser bundle into a temporary directory, assigned a unique QA bundle ID (`com.rogan.threef.browser.qa.onlychat20261031.history`), configured an isolated control descriptor, ad-hoc signed it, passed strict code-signature verification and `workflow-control verify-mac`, and ran the installed executable copy with the current Only Chat bridge. The installed app and Only Chat user session were untouched.

## Result

- Authenticated control service started and returned `/v1/status` HTTP 200.
- Both `navigate()` calls returned success.
- After navigation to `https://example.org/`, status reported URL `example.org`, title `Example Domain`, and `backURL=https://example.com/`; the process was still alive.
- The test harness required a body-text predicate (`Example Domain` for the first page and more than 700 characters for the second) before invoking history. Neither predicate became true within its wait period, so this run did not call the history endpoints. This is inconclusive for browser history, not evidence that history is broken. An earlier isolated current-source E2E separately recorded a successful back/forward cycle.
- Process output had no captured fault/error/termination lines. The QA process exited after cleanup, and its temporary app/profile/descriptor/log directory was removed.
- A compact, secret-free machine result is retained at `/Users/rogan/Library/Caches/CodexManagedArtifacts/onlychat-3f-history-focused-qa-20261031/run-result.json` under the delivery-proof 8-day disposable-output guard.

## Next action

Run one history-only verification after readiness is defined by authenticated status showing both the target URL and expected `backURL`; record the `history()` response and observed URL transition separately from page-body assertions. Keep installed-bundle runtime and Windows receiver validation open.
