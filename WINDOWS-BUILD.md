# Only Chat Windows 1.0.1 — 2026-10-27

Download `OnlyChat_Windows_1.0.1_x64_2026-10-27.zip`, extract it, then launch `win-unpacked/Only Chat.exe`.

For isolated QA, run `scripts/run-isolated-windows.ps1 -AppPath <path-to-Only-Chat.exe>`. It creates a unique profile under `%TEMP%`, waits for the app to exit, and removes that profile.

Drive sync and external provider integrations are disabled in isolated mode. The candidate is an unsigned Windows x64 development build. A Windows runtime check is still required before treating it as verified.
