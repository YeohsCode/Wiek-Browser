# Workspace / local Git implementation and validation

New files: `app/workspace-service.cjs`, `app/workspace-panel.js`, `app/workspace-panel.css`; fixture tests: `tests/workspace-service.test.mjs`.

Behavior requirements came from the shipped-artifact findings in `analysis/shipped-daemon-features.md` (REA Evidence `ev_0a7bdc68255ac1adb7db5fd967eaa355b6bbd1830efb7f12c750d8540dcbbee3`, shipped run:112964 and run:130376–130471). This is an independent implementation using Node built-ins and the local Git CLI. No private daemon implementation was copied.

## Main-process integration contract

```js
const { createWorkspaceService } = require('./workspace-service.cjs');
const workspaceService = createWorkspaceService({
  projects: () => agentService.snapshot().projects,
  onChange: () => publish(),
});
// Include this in the normal chrome state:
// workspace: workspaceService.snapshot()
// In the existing trusted-chrome IPC action handler:
if (name.startsWith('workspace:')) return workspaceService.dispatch(name, payload);
// Await during application shutdown:
await workspaceService.close();
```

Workspace actions return their own result directly, not the entire browser state. Keep the main handler's existing trusted renderer checks; ordinary web page renderers must not receive filesystem/Git actions. `projects()` is a trusted registry of real user-selected project paths; clients cannot supply an arbitrary root through an action.

Load `workspace-panel.css` and `workspace-panel.js` from the browser chrome. Mount a dedicated container with:

```js
window.VekWorkspacePanel.mount(container, (action, payload) => window.vek.action(action, payload));
window.VekWorkspacePanel.update(browserState.workspace);
```

`update()` also accepts `{workspace: snapshot}`. The panel fetches `workspace:snapshot` on mount, chooses registered projects, starts/stops project watchers, and preserves unsaved editor text across state events. Invoke IPC directly rather than the browser renderer helper that assumes every action returns a whole browser state.

## Actions and results

Every scoped action requires `{projectId}`. All paths are project-relative.

| Action | Additional input | Result |
|---|---|---|
| `workspace:snapshot` | none | projects, watches, lastEvent, capabilities |
| `workspace:tree` | path?, depth? (1–8), limit? (max 5000), hidden? | entries tree, path, count, truncated |
| `workspace:read` | path | content, SHA-256 hash, bytes, mtimeMs |
| `workspace:write` | path, content, expectedHash (null only for a new file) | saved content/hash/metadata |
| `workspace:search` | query, content? (false = filename), caseSensitive?, limit?, hidden? | matches with path/line/text, scanned counts, truncated |
| `workspace:artifacts` | path?, hidden? | previewable file entries, truncated |
| `workspace:preview` | path | text, safe raster image base64, or binary metadata |
| `workspace:watch` | enabled? (false stops) | snapshot |
| `workspace:git:status` | none | branch, porcelain entries with index/worktree/rename fields |
| `workspace:git:diff` | path?, staged? | stdout/stderr |
| `workspace:git:log` | limit? (max 100) | commits; empty for an unborn repository |
| `workspace:git:branches` | none | local branches/current/hash |
| `workspace:git:stage` / `unstage` | paths: string[] | Git stdout/stderr |
| `workspace:git:commit` | message | local commit stdout/stderr |
| `workspace:git:branch:create` | name, checkout? | local branch create/switch result |
| `workspace:git:branch:switch` | name | local branch switch result |
| `workspace:git:stash:list` | none | local stashes |
| `workspace:git:stash:push` | message?, includeUntracked? | stash result |
| `workspace:git:stash:apply` / `pop` / `drop` | stash, e.g. `stash@{0}` | local stash result |

The panel exposes file browsing/editing/new-file saving, literal search, artifact preview, Git status/diff/history, stage/unstage/commit, create/switch branch, stash operations and local change notifications. Destructive UI actions use local confirmation dialogs. File save conflicts stay visible and retain the user's draft.

## Boundaries and limits

- Scope uses canonical real paths and rejects absolute paths, traversal, outside symlinks, and `.git` metadata access including aliases. File handles use no-follow/nonblocking flags where available; only regular files are read. Git must identify the selected project itself as its repository root.
- UTF-8 editing/read is bounded to 2 MiB; binary/image previews use the same limit. Reads remain bounded even if the file grows. Writes require an expected hash, recheck before atomic replacement, serialize within this process, and clean temporary files. This is optimistic conflict detection, not a filesystem-wide transaction against hostile simultaneous renames.
- Tree limits depth/entries. Search excludes Git internals, dependency/build directories and symlink directories, caps 5000 scanned files/20 MiB/500 results and returns explicit truncation. Eight simultaneous project watchers maximum; nonrecursive fallback is declared in snapshot.
- PNG/JPEG/GIF/WebP display through data URLs. HTML/SVG and other UTF-8 artifacts show source as text. No executable preview, external viewer launch, or remote fetch occurs.
- Git uses argv through `execFile`, never a constructed shell command. Literal pathspec mode prevents user filenames from becoming Git pattern expressions; inherited `GIT_*` directory/index overrides are removed. Each command has a 20-second/4-MiB output bound. Existing repository hooks/signing follow normal Git behavior for a user-requested commit.
- Remote push/pull, PR APIs/comments, merge/rebase/reset, branch deletion and directory rename/delete are not implemented. No remote account operation was performed. These limits are explicit and do not claim full daemon parity.
- This worker did not modify main/preload/index/renderer or run SDK builds/browser E2E. Main-process/visual integration remains the root agent's responsibility.

## Exact validation

`node --test tests/workspace-service.test.mjs`: **11 passed, 0 failed, 0 skipped**, 1298.811625 ms on the final run. Raw output: `reports/workspace-service-tests.log`.

The permanent fixture tests use temporary directories and real local Git repositories only. They cover scope/traversal/symlinks/Git aliases, required hashes and external edit conflicts, concurrent save serialization, bounded tree/search, binary/oversize/image previews, real staging/commit/log/branch operations, stash restoration, literal pathspec/argv safety, inherited Git environment override removal, and watch/close behavior.

Both new JavaScript files passed `node --check`. A separate LinkeDOM probe (temporary dependency under `/tmp/vek-agent-ui-render`, no root dependency modification) passed scoped tree/read binding, literal HTML-source rendering, expected-hash save dispatch, Git stage dispatch, and visible local-only limitations. Raw output: `reports/workspace-panel-dom.log`. This DOM probe is not a browser screenshot or full Electron integration test.
