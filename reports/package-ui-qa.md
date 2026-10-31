# Packaged application UI smoke

Built macOS ARM64 `.app`, loaded using a dedicated `data/package-qa` profile. Inspected the native accessibility tree and app screenshot through CUA.

- Application starts with the browser chrome, Personal space, blank tab, omnibox and navigation controls.
- Agents & automations opens the integrated local Agent workspace.
- Providers view displays the actually discovered local Codex executable and its verified read-only CLI arguments.
- Creating `Package QA` with an existing temporary project directory succeeds.
- Creating `UI smoke — no model call` succeeds; history, idle status and composer render.
- No prompt was sent, model request made, or automation scheduled during UI smoke.

The first layout inspection found the composer footer below the default viewport; the thread panel height was reduced before the final package rebuild. Final screenshot and source/package hash verification are retained separately.

Additional packaged runtime checks:

- Native CUA omnibox navigation to a local data URL rendered `Vek Browser is running`.
- Entering `Vek` into the page field and clicking Continue visibly changed the heading to `Hello Vek`.
- The packaged app's own CLI + bundled SDK created a task, navigated, filled a role locator, clicked Apply, read `Packaged bridge works`, saved `package-browser-page.png`, and finished the task.

Final rebuild UI inspection:

- Existing Package QA project and idle conversation survived app restart.
- The final screenshot shows both composer and Send prompt button inside the default viewport.
- `reports/package-agent-final.png` is the final chrome capture; packaged source files and tested SDK hashes match in `package-source-verification.json` and `delivery-summary.json`.
