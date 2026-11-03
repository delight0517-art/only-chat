# Only Chat recurring schedules — Windows source patch

This is a selective overlay for the Windows canonical `app_source`. It was prepared against the Drive archive `OnlyChat_Windows_Source_Current.zip` (package version 1.0.5); it does not contain or replace the full app.

## Apply on Windows

1. Keep the current Windows app/source as-is. Unzip this package to a temporary working folder.
2. Run from PowerShell, passing the **current canonical Windows `app_source` directory** (not an old Drive snapshot):

   ```powershell
   node .\onlychat-recurring-schedules-patch\apply.js "C:\path\to\canonical\app_source"
   ```

3. The applier checks every source anchor and existing module path before writing. It stops before writing if the current files do not match or if schedule modules already exist. In that case, compare the current Windows source with the app archive and merge the change around local edits; do not replace the Windows tree with this package.
4. Run the repository's narrow tests and the supported Windows candidate packaging workflow. Keep the installed/running app, its drafts and account configuration untouched until a candidate passes.

## Feature scope

- Schedule rail button and manager: list, title, prompt, daily/weekly/monthly time, enable/disable, edit, delete, run now, last result, and up to five UTF-8 text/source attachments (64 KiB each, 128 KiB total).
- Schedule data and attachment files stay in the local Only Chat profile; they are not synced to Drive as user data.
- Recurrence uses the Windows local clock; day 31 runs on the last day in shorter months.
- Automatic and manual scheduled runs call the real `AgentEngine.executeTurn`, use a separate persisted session, and serialize against active chat/dispatcher work. In the background they are read-only: filesystem/shell execution, browser interaction, credentials, and write/send tools are blocked. The result reports any blocked change request so the user can run and approve it in a normal chat.
- Persisted in-flight runs are recovered as interrupted after restart and are not silently replayed. The following recurrence remains scheduled.

## Evidence boundary

The applier was exercised against the five relevant files from the 1.0.5 Drive source archive in a small disposable fixture, and the resulting server, renderer and schedule modules passed `node --check`. Mac schedule store/API tests and an isolated Mac API CRUD pass are separately documented in the task checkpoint. This is **not** Windows receiver, build, installed-app or runtime proof. Windows remains pending until the Windows canonical checkout applies the patch, its tests/build pass, and the receiver reports back.
