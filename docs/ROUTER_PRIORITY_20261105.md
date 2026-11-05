# Only Chat / AI Account Router priority repair

2026-11-05 KST. Task: onlychat-router-priority-20261105.

- Found three consumer defects: Router auto-discovery appended it as a fallback; the renderer clamped ranks above3 to3; the initial composer selection pinned a specific Codex model instead of automatic priority. Account identity labels also incorrectly depended on numeric rank.
- Discovery now promotes Router once, persists a migration marker, and preserves subsequent user reorder across restart. Rank loading and editing use unique sequential ranks. The composer defaults to automatic and migrates to Router automatic selection once on detection.
- Settings expose Router's account/model catalog and revisioned up/down controls through the Only Chat backend. Model writes validate at Router. Foreign browser origins and stale revisions are rejected.
- Live existing app configuration was changed using its own API: Router rank1, automatic=true, next provider=account-router. Persisted ranks are1..5; Router's internal account ranks remain1 and2.
- New backend tests pass: first discovery/user reorder durability, selected-model routing, five distinct rendered ranks, catalog/model/reorder API, origin guard, provider adapter and exact-hash reload. A temporary headless consumer also read the installed Router's two real account catalogs (8 models each), chose Router first and reported revision2026-11-05-v1. No real inference was performed in that check.
- The existing native Only Chat process still owns the old backend. A fresh main-app `/api/status` must expose `routerIntegrationRevision=2026-11-05-v1` after one user restart before the new server/core controls can be called live. No app launch, activation, input or screenshot was performed: an isolated AI UI route is not established.
- Router's separate 1.1.13 repair corrects a demonstrated Keychain save false-success. Old profile metadata is retained, but the old invalid token writes cannot count as working authentication. After per-profile re-login, verify each catalog and one real Only Chat response, then confirm quota-driven account transition using actual provider evidence when available.
- Remaining unrelated project TODOs and prior dirty changes remain outside this slice. Shared checkpoints are local-published; cloud/receiver ACK is not claimed.
