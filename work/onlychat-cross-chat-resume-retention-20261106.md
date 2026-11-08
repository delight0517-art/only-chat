# Only Chat cross-chat resume build retention

- Candidate retained: `/Users/rogan/Library/Caches/CodexManagedArtifacts/onlychat-cross-chat-resume-candidate-20261106.app`
- Candidate size: 5.8 MiB; executable SHA-256: `e748d6797ea1e08c558fbd56de5436cf3798a57814b9f64d08e86460dbc42476`.
- Reason: signed build is ready for the pending task-owned isolated UI check; it has not been launched or installed, so keep it as an active candidate.
- Superseded candidate outputs removed: none. This is the only candidate for this task.
- Existing installed app preserved: `/Users/rogan/Applications/Only Chat.app`, version `1.0.1`.
- Candidate process/open-file references: none observed; the candidate was not launched.
- Available Data volume space: 28.94 GiB before build, 28.93 GiB after build; 20 GiB reserve remains satisfied.
- Expiry: not registered; this candidate is unverified at the consumer layer and the delivery gate remains open.

## Follow-up candidate after current-chat resume fix

- Integrated source commit: `7094be1 fix: resume unfinished work from current chat` (one-line resume-owner fix only).
- Current signed candidate: `/Users/rogan/Library/Caches/CodexManagedArtifacts/onlychat-cross-chat-resume-candidate-20261106-r2.app`; executable SHA-256 remains `e748d6797ea1e08c558fbd56de5436cf3798a57814b9f64d08e86460dbc42476`; configured server port `18899`.
- Candidate's `project-root.txt` points at the canonical repository, so the app serves the integrated source tree. Candidate remains unlaunched and uninstalled pending isolated consumer verification.
- The prior candidate remains preserved because consumer verification is still open. Both are generated candidates for this active task; neither is registered for expiry.
- Build capacity preflight: 27.70 GiB free with 1.00 GiB peak budget; post-build: 27.70 GiB free, preserving the 20 GiB reserve.
