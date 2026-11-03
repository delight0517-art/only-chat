# Only Chat source ownership and live mutation

- `work-share active` is a resumable task checkpoint, not a source-file lease. Never treat it alone as an active edit conflict.
- Before blocking on another Only Chat task, check its current Codex thread status/last turn, exact `agent-coord` file leases, and actual writer processes for the paths being edited. An idle/completed thread with no exact lease or writer does not own the files. A running Only Chat UI/server process serves the source but is not itself a source writer.
- This source is a non-Git Antigravity scratch tree. If `agent-coord` cannot issue a lease here, record that limitation; do not turn an old task checkpoint into a substitute lock. Follow the latest direct user statement when it corrects stale ownership metadata.
- Use the existing Metamorphic Hub only through its supported paths: `.css` changes are stylesheet hot-reloaded; `.html`/renderer `.js` changes request a safe renderer reload and must preserve an in-flight turn, draft, attachments, and conversation; server/core/native module changes need their own verified reload/restart path. Do not claim a live update until the running UI reports/visibly reflects it.
- Preserve the existing running app and unrelated files. Make narrow edits and leave active request/session state intact.
