# Work incident → diagnosis → plan → execution → verification

User correction (2026-11-05): fix the incident where work stopped and make Only Chat actually continue the authorized work. A low-level lock helper plus a prose promise was insufficient.

## What failed

1. M-Oasis's own build gate was incorrectly treated as a cross-repository source lock. The scoped instruction correction is already recorded in M-Oasis and `WORKSPACE_COORDINATION_RECOVERY.md`.
2. AgentEngine flattened structured `WORKSPACE_BUSY` errors; the dispatcher moved the task directly to terminal `blocked`, even though no provider/tool had started and an automatic scoped recovery was safe.
3. The manager's executor system-message object was joined into text without reading `.content`, so the actual instructions were replaced with `[object Object]`.
4. Queue normalization dropped manager task/owner linkage. Progress could not reliably reach the saved task plan. Trusted manager context is now passed separately from untrusted queue inputs.
5. TaskRegistryStore rejected checkpoint changes within the same active phase. Diagnosis/recovery plans now update under the existing owner lease without pretending the execution phase completed.
6. Reentrant dispatcher ticks could be lost while a very fast worker ended. A requested tick is now scheduled after the current tick finishes. Activity guards also track worker IDs, so a waiting task ending cannot release another active worker's guard.

## Runtime flow

- Classify a local typed incident against the exact canonical workspace resource. Automatic recovery is limited to zero attempted/successful/failed tools, no allowlist violation, and observable same-host ownership (or a free resource). Foreign/unknown owners and human-action gates stay unresolved.
- Persist the diagnosis and recovery plan through the existing private session metadata and manager task checkpoint **before** resuming. Failed persistence prevents automatic replay.
- Put that logical task in `waiting`, release its execution/activity slot and run eligible independent queued work. Keep its original prompt, allowlist and file scope.
- Re-check only that live request's actual workspace with bounded cancellation-aware observation. A released or provably dead owner permits a new normal acquisition; acquiring again still protects against races. Save the fresh readiness observation before requeueing.
- Resume the original logical task. Keep its workspace bound even if the user changes the parent chat workspace while it waits. The same task-plan identity reaches final executor progress and verification evidence.
- Allow at most two recovery rounds. Persistent contention, stop/cancel, unknown ownership, or evidence of an already attempted tool produces a precise pending checkpoint. Do not replay possible mutations, bypass approval, or equate an unrelated repository's gate with this task's ownership.

There is no new daemon, recurring automation or automatic restart replay. Saved incomplete executor plans continue using the existing explicit resume mechanism after a restart; completed executors remain preserved. Ordinary tool/provider failures are not silently cleared or counted as success.

`GET /api/dispatcher` now reports recovery version, scope, maximum attempts and current waiting count. This provides a loaded-runtime capability check without implying that a source commit is already loaded in the user's app.

## Verification and delivery

The end-to-end regression uses a real local workspace lease, the actual isolated DesktopServer/AgentEngine/dispatcher, private durable task storage, and an actual `read_file` tool through a synthetic provider. It observes waiting through the HTTP API, reopens the registry to verify the diagnosis/plan, releases ownership, changes the parent workspace to catch wrong-target retries, then verifies exactly one successful tool execution and final parent `verifying` state. No real provider or user repository is mutated.

Other scenarios exercise independent work while waiting, bounded recovery, stop cancellation, no retry after a tool attempt, wrong resource/foreign ownership, untrusted ownership-field injection, checkpoint failure, and activity-guard ownership. Existing lease, task registry, dispatcher evidence/approval and manager regression suites remain required.

Core/server source is integrated on canonical main. Applying it to an already-running app needs a safe normal server start with drafts, recording and active work preserved; no UI control or restart is implied by this source slice. Rollback reverts only this slice's exact commit and leaves unrelated dirty hunks intact.
