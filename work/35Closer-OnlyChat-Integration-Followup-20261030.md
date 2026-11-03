# Only Chat ↔ 35Closer integration follow-up — 2026-10-30

This is a Windows-side adaptation handoff for the existing `35Closer-OnlyChat-Sleep-20261030` packet in this folder. It records a new Only Chat Mac source slice; it does not claim Windows application or runtime completion.

## Mac source delta

- `src/connectors/OnlyChat35CloserMcpServer.js`: restricted MCP calls the 35Closer CLI with shell execution disabled. It exposes submit/list/cancel only; cancellation checks that the request belongs to Only Chat and is still `pending_user_approval`.
- `src/providers/CodexCliAdapter.js`: registers the MCP for macOS Codex sessions and instructs the agent to request 35Closer UI approval before power changes.
- `src/tools/ToolRegistry.js`: blocks direct shell power mutations and directs the agent to the 35Closer approval route; read-only `pmset -g` remains available.
- `tests/onlyChat35CloserMcp.test.js`, `tests/powerActionRouting.test.js`, `tests/codexCliAdapter.test.js`: focused checks; adapter suite passed 8/8, MCP and power guard checks passed, and `priorityChain.test.js` passed.

## Windows adaptation required

1. Read the current Windows Only Chat and 35Closer source revisions and dirty state before editing. The Mac Only Chat source is a non-Git scratch tree; do not transplant its files wholesale.
2. Adapt the same request/list/pending-cancel contract to Windows-native local IPC and the Windows 35Closer service. The existing 35Closer Mac packet provides the persisted intent and human UI approval contract.
3. Keep approval in the 35Closer Windows UI. A request must never execute sleep/shutdown by itself. Preserve current power policy, active-work checks, request expiry, and idempotency.
4. Provide a Windows Only Chat bridge behind a detected/connected Windows 35Closer capability. Until a Windows 35Closer endpoint exists, report the capability as unavailable and do not expose a broken or Mac-path-only command.
5. Add Windows command guards for direct sleep/shutdown/restart mutations and tests proving request, list, pending-only cancel, approval-required behavior, disconnection, and failure handling. Use a mock service for tests; never cause a real power transition.
6. Report Windows source, focused tests, build, install, live request receipt, UI approval result, and power-policy readback as separate evidence. Do not claim a receiver ACK until the Windows machine reads and applies the handoff.

## Current evidence and boundary

- Mac source checks passed for the three changed JavaScript modules. Only Chat MCP, power-command guard, Codex adapter, and priority-chain focused checks passed.
- 35Closer request service/CLI candidate commit: `1fe30f12c3d62362de522b7fc9dfdefad2d3cb3e`. Its 13 CLI tests, four request-service tests, eight local API tests, and selected Dart analysis passed in the isolated source worktree. The same source patch has now been applied to the canonical 35Closer checkout without staging or replacing unrelated dirty edits; `git diff --check` and `python3 test/agent_cli_test.py` (13/13) passed there. Flutter/API UI tests have not been rerun in the canonical checkout.
- The installed 35Closer app is 1.1.0 build 118 and is not running; no API listener is present at `127.0.0.1:8765`. A safe debug candidate build was blocked by the storage guard at 19.50 GiB free versus 21 GiB required. No real request was submitted and no sleep action was executed. Installed Only Chat sessions were left running.
- Source integration is not install/runtime proof. Only Chat's default 35Closer CLI path now resolves to the canonical script, but the installed 35Closer app still needs the updated local API before consumer calls can succeed.
- Windows state is expired/unknown. This document is a Drive handoff only; Windows source application, build, install, UI approval, and runtime remain unverified.

## Mac Only Chat source hashes

- `src/connectors/OnlyChat35CloserMcpServer.js`: `e5441ae105444280e6ef358d0bc2742086994919cf26a0e10f92133c190db22f`
- `src/providers/CodexCliAdapter.js`: `e496bfce24f1e7fc3c90ba4ead0b8f1b09e7c21709aabed880f2829dc5abc7b2`
- `src/tools/ToolRegistry.js`: `f4d32507459e3545a005e22e3f68160d0b172d3c82ceac6b0e87b2e0b0cb075c`
- `tests/onlyChat35CloserMcp.test.js`: `e5fa90222d0ec6238a8bf19d5098eed04fbd18ecef45e07759fa50d27eac8ffb`
- `tests/powerActionRouting.test.js`: `64c6c7f7b87070807936826500005cff7f4bd9fb928819b9a8d2195c87709430`
