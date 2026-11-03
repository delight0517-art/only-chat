# Only Chat Windows handoff progress — 2026-10-31 KST (v11)

This update adds fresh schedule execution evidence to the existing 3F/Windows handoff chain. It does not claim Windows receiver execution.

## Actual schedule → GPT-6 Luna → tool result

- In an isolated temporary profile and workspace, a disabled synthetic monthly schedule was manually triggered once through `RecurringScheduleService.runNow`.
- Only Chat's actual `CodexCliAdapter` selected `codex-primary`, model `gpt-6-luna`, reasoning effort `low`.
- The task invoked `exec_command` for `node --check fixture.js`. Recorded evidence: attempted 1, succeeded 1, failed 0; exit code 0; the schedule persisted as `completed`; the task session was readable.
- The temporary schedule, profile, fixture and session data were removed after the readback. This proves the current-source scheduler/service/dispatcher/provider/tool-evidence path in isolation. It does not prove the installed app's API/UI, its recurring 60-second due-time tick, or Windows execution.

## Mac installed app and 3F status

- Installed Only Chat PID 4031/server 4071 remains on an older runtime. `/api/schedules` is HTTP 404 there. The app's existing unsent draft/session has been preserved, so no restart was performed.
- The installed Only Chat 3F settings route remains absent; its legacy embedded browser status points at `about:blank`. A safe test navigation previously failed closed because the installed server could not confirm Focus Fence policy.
- The separate installed 3F Browser runtime terminates shortly after launch. Captured SIGTERM evidence identifies a Focus Fence process as the sender, but the exact termination decision/cause is not proven; the Focus Fence working tree is dirty and was not changed. Standalone navigation/page/history readback and Focus Fence blocked-page behavior are still unverified.

## Windows handoff and evidence boundary

- Existing selective schedule patch: `OnlyChat_Windows_Recurring_Schedules_Patch_20261030.zip`, Drive ID `1eiqorlqnt5xwcWS7eWbhiGfgL7pK9Jgf`.
- Existing combined work-progress/elapsed-time and 3F history-control patch: Drive ID `1P4fC0QrlEso3a-tX9axnajv0IH9jKS3r`; guide ID `1K4opbM6D_ouJ8rz5HD4PR4ZDmCYH1dBb`.
- Existing 3F diagnostic report v10: Drive ID `17NnD1HANOSegzNpZMBBdrD851Iv_6_hU`.
- Windows source apply, build, install, runtime, receiver ACK and cross-device behavior are unverified. Windows availability is unknown/expired, and no remote Windows probe was made. The patches remain handoffs for the receiver to apply and validate.

## Current priority-chain snapshot (installed Only Chat read-only API)

- Auto priority is ON. Antigravity is at 0% and throttled.
- Tier 2 GPT-6 Luna Codex account is disconnected and has unknown quota; tier 3 GPT-6 Luna primary is connected and currently selected.
- Therefore the current resolver skips exhausted tier 1 and unavailable tier 2, then selects tier 3. This API snapshot does not prove a newly sent user message or the visible active-account label.
