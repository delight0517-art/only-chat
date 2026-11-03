# Only Chat source custody baseline — 2026-11-03

## Canonical source

- Canonical source: `/Users/rogan/.gemini/antigravity/scratch/my-codex`.
- Canonical integration branch: `main`.
- This source folder had no Git metadata. There is no local commit ancestry or prior base from which the pre-existing changes can be reconstructed. The first Git commit records the reviewed canonical application source as a dated baseline; it does not claim to identify each file's original author, reconcile unknown historic versions, or verify a released/installed app.
- M-Oasis owns portfolio task intake, leases and integration records. Only Chat owns the task-planning/execution UI and durable task state. Project instructions in `AGENTS.md` remain authoritative for this source folder.

## Source included in the baseline

The baseline covers the current application code, tests, build scripts and documentation: `src/`, `tests/`, `bin/`, `scripts/`, `macOS/`, `docs/`, `licenses/`, `package.json`, `package-lock.json`, `README.md`, `LICENSE`, `AGENTS.md`, `TODO_ROADMAP.md`, and `WINDOWS-BUILD.md`.

`git show --stat` and the commit tree are the authoritative file inventory and hashes. The current installed app, remote Windows checkout, remote provider deployment, and external/installed runtime are separate evidence stages.

## Preserved outside the source baseline

- `node_modules/`, `.build/`, `dist/` and `coverage/` are generated outputs. `.gitignore` excludes these paths; none were removed.
- `work/` contains candidate patches, handoffs, and runtime-smoke material. It remains visible to Git for later task-by-task reconciliation; do not hide, delete, or blanket-commit it.
- `CODEX_HANDOFF.md`, `MAC-EXECUTION-CARD-2026-10-28.md`, `MAC-INSTALL-RETENTION-2026-10-28.txt`, and `PROVENANCE_MANIFEST.md` are existing local handoff/retention/provenance records. They remain unchanged and uncommitted until their provenance and purpose are checked against current state.
- No credentials, local runtime/user data, candidate app bundles, or generated build outputs are part of this baseline.

## Follow-up

- Keep one in-place task lease on `main`; do not create task branches or worktrees.
- Review preserved `work/` items against their task checkpoints and current canonical code. Integrate only owned, compatible feature slices with focused checks and separate commits.
- Establish exact repository commits and provenance for future changes before claiming per-file historic ownership. The initial baseline starts new history from the source observed on this date.
- Record source commit, focused checks, signing/build, install, live loaded revision, provider/server, receiver, and device evidence as separate stages. This baseline makes no release or runtime claim.
