# AI Account Router provider module morph

## Scope

AI Account Router is a shared local service for apps that can use an OpenAI-compatible endpoint at `http://127.0.0.1:18880/v1`. An app without a custom provider setting needs its own small adapter. Router credentials stay in Router's credential store; they must not be copied into the consumer app.

Only Chat's isolated consumer boundary is `src/features/provider/v1.mjs`. `src/features/provider/AccountRouterModuleSlot.js` loads only that exact allowlisted file. It hashes the source before import, imports the hash-versioned module, checks the source hash again, and publishes the new adapter only after the v1 export contract passes. An in-flight provider call keeps its adapter reference; later calls resolve the current source hash.

## Runtime receipt contract

`EvolutionInbox` now forwards `getBlockers` and `verifyReload` to `EvolutionRelay`. The desktop server defers all incoming source updates while an Only Chat turn is active. For the exact single-file Router packet, it calls `AgentEngine.verifyMetamorphicProviderReload({ files, signal })`; the verifier returns a loaded hash only when the module imported successfully and its SHA-256 matches the packet's `newHash`. It rejects other files and multi-file packets so unrelated code cannot be executed under this provider-module slot.

For other allowlisted modules, the server explicitly returns `source-applied` without a runtime ACK; the relay preserves the source but does not claim it was loaded. If the Router verifier fails, the relay rolls back the exact source preimage and emits no runtime ACK. Multi-file packets containing the Router module are rejected and rolled back.

## Current state

- Source adapter and hash-versioned module slot exist.
- Focused source syntax checks passed for the slot and `AgentEngine.js`.
- Runtime verifier is connected through EvolutionInbox and EvolutionRelay; a temporary integration check verified busy deferral, exact-hash ACK, in-flight adapter preservation and next-request module refresh.
- Installed Only Chat is still running its earlier AgentEngine/server process; no restart was performed because unsaved draft safety and current shared-source ownership have not been proven clear.
- The Mac Router currently reports two demo profiles and zero eligible real provider profiles, so no real inference is available yet.

Keep future changes in this provider boundary when only Router request/response behavior changes. Changes to AgentEngine, server, native code, persistence or the relay require their own exact module ownership and proof; do not expand a provider patch into a whole-app lock.
