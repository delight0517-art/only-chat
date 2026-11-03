# Only Chat Google Workspace MCP — Windows port handoff

Date: 2026-10-30 KST
Task: `onlychat-google-workspace-plugin-20261030`
Target: the current Windows Only Chat canonical source and its provider/runtime owner.

## Change in the Mac reference source

The Codex CLI provider starts a local stdio MCP server for each request. It exposes four read-only tools: `drive_search`, `drive_read`, `gmail_search`, and `gmail_read`. Drive reading is limited to supported text exports and 1 MiB. Gmail body output is limited to 64 KiB and attachments are omitted. The MCP process reads the same locally stored OAuth token file as Only Chat's connector. Account Router tool routing also has a `google_drive_read` action.

The Google Workspace settings description identifies the available tools and refreshes its connection badge when the OAuth popup closes. MCP does not expose Drive writes or Gmail sending; any pre-existing write/send route remains behind Only Chat's existing approval behavior.

## Windows port requirements

- Review the included files against the current Windows source; this is a reference patch bundle, not a replacement Windows source tree or installable build.
- Integrate the four read tools with the current Windows Codex/provider runtime. Do not copy Mac-only CLI paths or assume that Mac `CodexCliAdapter` is the Windows provider.
- Use the existing Windows Google OAuth/token storage boundary and a loopback callback supported by the Windows app. Never copy an OAuth token, browser session, chat data, or account identifier from Mac.
- Keep Google access optional until the user connects an account. Keep these MCP tools read-only; do not add mail sending or Drive mutation to the MCP surface.
- Add/adjust Windows-focused tests for tool discovery, bounded text output, disconnected-account behavior, and the existing read-only/approval policy.
- Source delivery is not proof of Windows receipt, integration, build, installation, OAuth consent, or runtime behavior. Record each only after Windows readback.

## Mac source verification

`node tests/googleWorkspaceMcpServer.test.js`, `node tests/connectors.test.js`, `node tests/approvalPolicy.test.js`, and `node src/features/provider/v1.test.mjs` passed. `node --check` passed for every changed JavaScript file. The running Mac app was not restarted: its source server predates this change and has an unsaved user draft. Google OAuth consent and actual Gmail/Drive calls remain pending.
