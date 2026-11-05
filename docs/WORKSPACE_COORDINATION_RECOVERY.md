# Scoped, resumable work — 2026-11-05

The user requested fixing the incident where an unfinished M-Oasis task stopped unrelated 3F edits, then applying the recovery structure to Only Chat.

## Diagnosis and plan

M-Oasis `work:check` is a build/integration gate for its own checkout. Applying its result to another repository was an operator scope error. A task record marked `active` is historical coordination metadata, not proof of a live source writer. The existing Only Chat `OwnershipLock` already admits independent paths and its task registry conflicts only within the same canonical repository and overlapping paths. Preserve those boundaries.

1. Resolve canonical repository and exact requested paths. Register a M-Oasis task packet under a disjoint metadata lease; acquire actual app-file leases. Keep one canonical branch.
2. Classify source edit leases, workspace execution leases, integration/build gates and runtime reload eligibility separately. Each blocker must name the measured resource, type, owner, observation time, and next action. A failure in another repository cannot establish this repository's lock.
3. Plan a small accepted feature slice with its callers, state to preserve, narrow verification, apply boundary and rollback. Continue independent slices when one overlaps a live writer; preserve dirty and untracked work.
4. For runtime contention in one workspace, Only Chat agent turns now wait up to 30 seconds, retrying acquisition without replaying any operation. Release automatically admits a waiting turn. `workspace_waiting` and optional `onWorkspaceWait` carry fresh, scoped evidence. An AbortSignal cancels waiting and prevents later execution.
5. A same-host owner confirmed dead can be reclaimed. New locks also retain process birth identity to reject PID reuse. Unknown identity, malformed records and foreign-host ownership stay protected. Waiting ends with structured `WORKSPACE_BUSY`, retryability, fresh evidence and an exact next action; it never deletes an uncertain lock. A leftover reclaim guard is protected and may require explicit owner diagnosis; no guarantee of unconditional progress is claimed.
6. Persist task checkpoints and outstanding work before returning a genuine blocker. Resume from the pending slice, re-reading actual ownership. No periodic human-action polling or global agent restart is added.
7. Check and integrate explicit source paths. Source/test success is separate from a signed candidate, installed loaded revision, and visible runtime. Core/server edits require a safe normal restart; preserve drafts, recordings, active turns and auth. Stop at genuine permission, account, data or live-writer gates.

## Implementation and verification

- `WorkspaceExecutionLease.run(..., options)` supports bounded wait, cancellation and scoped wait evidence; default direct callers retain immediate acquisition semantics. AgentEngine selects a 30-second wait and forwards its turn AbortSignal.
- Expired AsyncLocalStorage descendants cannot reuse a released lease. Reentrant calls during the original active operation still reuse it.
- Scope uses the canonical real path hash, so separate workspaces proceed independently; symlink aliases resolve to one resource. This is a workspace execution guard, not a portfolio-wide source edit lock.
- Tests exercise real child-process crash recovery, owner release and continuation, simultaneous workspaces, bounded timeout, cancellation, foreign/malformed ownership preservation, process identity mismatch, escaped async contexts and the actual AgentEngine call boundary. Existing multi-process contender and status/API tests remain in place.

## Apply and rollback

Keep the current running Only Chat untouched until its draft/recording/in-flight turn state and an isolated UI route are verified. The changed core module is consumed at the next safe normal app/server start; there is no source-only claim of live adoption. Revert only this slice's WorkspaceExecutionLease changes and the constructor/executeTurn hunks in AgentEngine if regression requires rollback; preserve all unrelated pre-existing AgentEngine changes. No new provider calls, branches, schedulers or deployments are part of this change.
