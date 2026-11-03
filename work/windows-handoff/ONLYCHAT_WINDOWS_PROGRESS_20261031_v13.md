# Only Chat Windows progress — 2026-10-31 v13

This is a Mac-side status handoff. Windows has not been probed, and no receiver-side apply, build, install, UI, or runtime ACK is confirmed.

## New 3F / Focus Fence evidence

- Read-only `GET http://127.0.0.1:17361/rules` returned HTTP 200 `application/json` with a 1,031,740-byte rule payload and expected top-level keys.
- The request had no `browser=3f` scope and did not mark a 3F contact. It proves the Focus Fence rules endpoint responds, not that Only Chat or 3F completed a handshake.
- The 3F Browser app is not currently running. Installed Only Chat is stale and its visible draft/session is being preserved; its old browser API still does not prove standalone 3F control.
- Focus Fence's dirty source contains 3F-specific app-block exceptions, but the running policy decision at the earlier 3F exit is not proven. That repo has extensive unrelated dirty/untracked changes and unclear ownership. Do not overwrite, build, install, or restart Focus Fence from this snapshot.
- Do not mark 3F complete. Next proof must be an actual 3F launch, `/rules?browser=3f` contact, safe test-page navigation/readback, back/forward, and Focus Fence blocking—all without using private pages.

## Existing Only Chat progress

- Current-source schedule API → actual GPT-6 Luna low provider → `exec_command` completed with exit 0 in an isolated temporary profile; schedule readback was `completed` with a session ID. This does not verify the installed app, recurring due tick, or Windows runtime.
- The Windows v12 handoff contains the schedule API evidence. Its receiver-side application/build/install/runtime/ACK remains pending.

## Next actions

1. Resolve the exact Focus Fence source/runtime ownership boundary before any edits to that repository.
2. Continue an isolated, non-disruptive 3F launch diagnosis; preserve the existing Only Chat draft and running sessions.
3. Apply and validate compatible Only Chat changes on Windows when Windows-side receiver evidence is available. Do not claim Drive upload as receiver execution.
