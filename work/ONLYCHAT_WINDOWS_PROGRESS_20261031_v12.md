# Only Chat Windows handoff progress — 2026-10-31 KST (v12)

This update adds a real isolated HTTP/API execution result. It does not claim Windows receiver execution.

## Schedule API → GPT-6 Luna → tool result

- Started a fresh temporary Only Chat `DesktopServer` from current source in isolated mode, with a disposable profile/workspace and a single disabled synthetic monthly schedule.
- `POST /api/schedules` returned HTTP 201; `POST /api/schedules/:id/run` returned HTTP 202.
- The actual `CodexCliAdapter` selected `codex-primary / gpt-6-luna / low`, then executed `exec_command` for `node --check fixture.js`. Result: exit code 0; attempted 1, succeeded 1, failed 0. The API read the schedule as `completed` and the task session was readable.
- Cleanup readback: schedule DELETE returned HTTP 200, schedule list returned 0 items, and the temporary profile/workspace was removed.
- This proves the current-source isolated schedule HTTP API → dispatcher → actual Codex provider → tool evidence path. It does not prove the installed app's schedule UI/API, the 60-second recurring due-time tick, or Windows execution.

## Mac installed app and 3F status

- Installed Only Chat PID 4031/server 4071 is still on an older runtime; `/api/schedules` returns HTTP 404. Its existing unsent draft/session is preserved; no restart was performed.
- The installed Only Chat 3F settings route remains absent; the legacy embedded status points at `about:blank`. A safe test navigation previously failed closed because the installed server could not confirm Focus Fence policy.
- The separate 3F Browser app still terminates shortly after launch. Captured SIGTERM evidence identified a Focus Fence process as sender, but not the exact decision/cause. Its dirty source was not changed. Standalone navigation, page/history readback and Focus Fence blocked-page behavior remain unverified.

## Windows handoff and evidence boundary

- Existing recurring schedule patch: `OnlyChat_Windows_Recurring_Schedules_Patch_20261030.zip`, Drive ID `1eiqorlqnt5xwcWS7eWbhiGfgL7pK9Jgf`.
- Existing combined work-progress/elapsed-time and 3F history-control patch: Drive ID `1P4fC0QrlEso3a-tX9axnajv0IH9jKS3r`; guide ID `1K4opbM6D_ouJ8rz5HD4PR4ZDmCYH1dBb`.
- Existing 3F diagnostic report v10: Drive ID `17NnD1HANOSegzNpZMBBdrD851Iv_6_hU`.
- Windows source apply, build, install, runtime, receiver ACK and cross-device behavior remain unverified. Windows availability is unknown/expired; no remote Windows probe was made.

## Current priority-chain snapshot (installed Only Chat read-only API)

- Auto priority is ON. Antigravity is at 0% and throttled.
- Tier 2 GPT-6 Luna Codex account is disconnected with unknown quota; tier 3 GPT-6 Luna primary is connected and selected. This matches the resolver skipping exhausted tier 1 and unavailable tier 2, then selecting tier 3.
- This API snapshot does not prove a newly sent user message or the visible active-account label.
