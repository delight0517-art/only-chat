# Only Chat Router restart candidate retention — 2026-11-06 KST

- Canonical source: `/Users/rogan/.gemini/antigravity/scratch/my-codex`, `main@9ae4cb4f5c99bb55e5382de20392a7a0a3f95ddb`; all pre-existing modified/untracked files preserved.
- Current generated candidate retained for pending install/runtime verification: `.build/Only Chat Runtime Candidate Restart Fix.app`, version `1.0.1`, executable SHA-256 `60d81abec78fc5a71e9e25e6c083bd519e861bdbcd716cdc151de2724236e3df`; signature and `workflow-control verify-mac` passed.
- Previous signed candidate retained as the single rollback for this task: `.build/Only Chat Runtime Candidate.app`, executable SHA-256 `91f91cdf9cd8d4eb26168ac95cc1564d67cca7aa0e803f7643a175664af0dade`. It predates the SIGTERM exit-code fix.
- Existing installed user app retained unchanged: `/Users/rogan/Applications/Only Chat.app`, executable SHA-256 `c37faa704397c34c52db62157d2923b761ed578ac33634b69991bc275a9559cd`. No bundle replacement or app launch occurred.
- No prior candidate was deleted. Older `.build` candidates belong to earlier Only Chat tasks and were not retired without exact ownership/reference evidence. The new candidate is not disposable because install/runtime proof remains pending.
- Temporary isolated process-test profile was removed by Python `TemporaryDirectory`; `/tmp/onlychat-supervisor-*` readback found zero remaining directories. Temporary UI screenshots, guest profile and prior test server/tunnel were already removed. No temporary source clone was created.
- Capacity readback: 32.08 GiB free before build, 32.09 GiB after; 2.00 GiB peak estimate; 20 GiB reserve satisfied.
- Retention state: current candidate plus one prior candidate rollback retained. Installed app preserved. No source, user data, credentials, session records, or app data deleted.
- Outstanding: install into the actual app path and verify native WKWebView model selection/restart behavior through an authorized isolated macOS UI route.
