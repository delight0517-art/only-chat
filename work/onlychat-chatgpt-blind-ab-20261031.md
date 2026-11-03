Only Chat vs ChatGPT host — controlled synthetic coding comparison
Date: 2026-10-31 KST

Task: independently parse TCP ports from numeric values/decimal-digit strings; reject invalid types/syntax and values outside 1..65535. Both sides received the same Node built-in test fixture and initial buggy implementation, in separate temporary workspaces.

Only Chat path:
- Current-source CodexCliAdapter; provider `codex`, model `gpt-6-luna`, reasoning `low`, account tier `codex-primary`.
- Observed real tool events: workspace read via `exec_command`, a `file_change`, then `node --test test/parseTcpPort.test.js` with exit code 0.
- Independent host rerun of the resulting workspace: 2 tests, 2 pass, 0 fail.
- Adapter round trip 13,301 ms (includes CLI/model latency and tool work).

ChatGPT host path:
- Solved the same prompt from the same test fixture before inspecting the Only Chat result; used a separate workspace.
- `node --test test/parseTcpPort.test.js`: 2 tests, 2 pass, 0 fail; measured test process 110 ms. This is not a model-response latency measurement.

Comparison:
- Both produced semantically equivalent input validation and passed identical acceptance tests. This small case found no correctness gap.
- Only Chat's tool receipts make file reads, changes, and command exit status observable. The round-trip and local test times have different scopes and do not support a speed ranking.
- Scope is a synthetic CLI/provider experiment, not installed Only Chat UI, production work, broad model quality, or Windows receiver proof.
- An earlier attempt was not blind because the host side inspected Only Chat's solution before completing its test; that attempt is excluded from the comparison.
- Both temporary workspaces were removed in `finally`; no user files or app sessions were read or changed.
