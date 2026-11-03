# Only Chat Windows progress — 2026-10-31 v14

This is a Mac-side handoff. Windows has not been remotely probed. Receiver-side source application, tests, build, install, UI, runtime, and ACK remain pending.

## New Focus Fence / 3F evidence

- Read-only `GET http://127.0.0.1:17361/usage/browser-protection` returned HTTP 200 from the running Focus Fence app.
- Its live browser catalog contains Safari, Chrome, Aside, and Firefox; it contains no 3F entry. Current Focus Fence source defines a 3F policy path, so the runtime is behind the checked source capability.
- This does not prove the exact reason for the earlier 3F termination. No `/rules?browser=3f` request was sent, so no synthetic 3F contact was recorded. No policy change, app restart, or install was performed.
- Focus Fence has broad dirty source under a related active task. Do not rebuild/restart it until ownership of the relevant policy files is resolved.
- Only Chat standalone 3F control, safe navigation and readback, back/forward, and Focus Fence blocking remain unverified.

## Windows schedule feature

- Selective Windows v1.0.5 recurring-schedule source patch: [ZIP](https://drive.google.com/file/d/1D2meAVlhhCc35ykEQMIF2GUYc0ykN6_E/view), [README](https://drive.google.com/file/d/1ajfDd75wipdJyiVT0VVvIEQLhcif6QOa/view).
- ZIP integrity check passed and the four packaged JavaScript files passed `node --check`. Drive connector readback matched the uploaded ZIP SHA-256 `b4a854810c0ccc6c4070252b701e503bdafe7d6b22a754c66f599f84b089ebbd` and the README text exactly.
- This verifies the handoff artifact only. Windows application/build/install/runtime remain pending.

## Next actions

1. Resolve Focus Fence ownership before updating the running binary to the source version that recognizes 3F.
2. When a safe path exists, verify an actual 3F `/rules?browser=3f` handshake, safe test-page navigation/readback, back/forward, and policy blocking.
3. Apply and validate the schedule patch in the Windows canonical checkout when receiver-side access/evidence is available.
