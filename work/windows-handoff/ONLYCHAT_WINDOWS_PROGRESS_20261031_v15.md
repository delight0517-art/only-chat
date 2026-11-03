# Only Chat and 3F Browser Windows progress — 2026-10-31 v15

Updated: 2026-10-30T20:07:23Z (UTC). This is a Mac-side handoff. Windows has not been probed; receiver-side application, build, installation, runtime, and ACK remain pending.

## Current Mac readbacks

- Installed Only Chat at `127.0.0.1:8899` returns HTTP 404 for `GET /api/browser/threef/open`; the installed runtime is older than the current 3F bridge source. The active window and unsent draft were left untouched.
- Isolated Only Chat candidates at ports 18998 and 18996 return HTTP 200 for 3F settings/status, with `enabled=false`, `available=false`, and `controlAvailable=false`. They have not been changed.
- Existing isolated 3F QA evidence: authenticated status and safe navigation/read/text/ARIA passed for `example.com` and `example.org`; back/forward passed in the history-fix candidate and remained inconsistent in another candidate profile. Do not treat this as installed Only Chat or installed 3F proof.
- The installed 3F bundle passes `workflow-control verify-mac`, but its process did not remain running in the latest launch attempt. Earlier bounded diagnostics recorded the control listener disappearing about one second after startup; no cause has been established. No further launch retry is planned until that evidence is reconciled.
- The live Focus Fence catalog previously read back Safari, Chrome, Aside, and Firefox, with no 3F entry. Focus Fence has dirty source under an unresolved ownership boundary; no policy edit or restart was made.
- Only Chat priority readback: Antigravity Tier 1 is at 0% and throttled; GPT-6 Luna Tier 2 is disconnected; GPT-6 Luna Tier 3 is connected and active. Therefore real Tier 2 fallback is still unverified.

## Existing Windows handoffs

- Work-progress/3F history patch and instructions are already in `OnlyChat_NCHISim_Sync`: patch `1PFl4bwCUvkGO5Hy2f0lQq0aH7wDKjI9g`, README `1K4opbM6D_ouJ8rz5HD4PR4ZDmCYH1dBb`.
- Recurring-schedule patch ZIP `1D2meAVlhhCc35ykEQMIF2GUYc0ykN6_E` and README `1ajfDd75wipdJyiVT0VVvIEQLhcif6QOa` were uploaded and read back.
- These files are transport artifacts only. Windows source application, tests, build, install, runtime behavior, and receiver ACK are not proven.

## Next receiver steps

1. Apply the selective 3F/work-progress patch and recurring-schedule patch to the Windows canonical source.
2. Run the included focused checks, then build/install and verify Only Chat → 3F navigation, safe-page text/ARIA readback, browser history, schedule UI/save/run, and the actual work-progress elapsed-time display.
3. Return a receiver-side source revision/hash, build/install evidence, runtime readback, and ACK.
