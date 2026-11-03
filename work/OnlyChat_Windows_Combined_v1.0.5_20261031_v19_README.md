# Only Chat Windows v1.0.5 combined source patch v19

This patch is based on `OnlyChat_Windows_Source_Current.zip`, SHA-256 `04000fb805bcf12c5aba5d30371a69a67408188b139ee96ff14f1ac3616b28e0`. It combines the previously verified v18 changes (work-progress/time UI, 3F browser history, recurring schedules, and the Codex CLI developer-instructions boundary) with the schedule `nextRunAt` preservation fix and Korean session-search error guidance.

Patch SHA-256: `75adf60e3814587f1cf832002368a26c1960282a323196df4ed65148e456a58a`.

## Session-search error behavior

- HTTP 504 says the 20-second limit was exceeded and asks the user to shorten the query.
- Other HTTP failures use a separate request-failed message.
- Network failures say the search server could not be reached and suggest checking the connection.
- Stale request responses do not replace the current search result.

## Mac-side checks

The patch was applied to a fresh extraction of the exact v1.0.5 baseline and then reapplied with `patch --fuzz=0` to a clean baseline. Focused checks passed: renderer and test `node --check`, `desktopSessionSearch.test.js`, `assistantWorkProgress.test.js`, `codexCliAdapter.test.js`, and `embeddedBrowser.test.js`. Existing v18 schedule runtime harness evidence is documented in its predecessor README; the complete `npm test` suite is not claimed as passing.

Windows receiver has not applied this patch. Before applying, compare the receiver source to the exact baseline SHA and confirm it has no local changes. Stop if it has advanced or contains edits; do not replace the receiver tree. Windows build, installation, live runtime, and ACK remain pending. Drive upload/readback alone does not establish receiver application.
