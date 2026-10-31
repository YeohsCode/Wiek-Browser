# Vek local Git checkpoints (v0.3)

Implemented independently in `app/workspace-service.cjs` and `app/workspace-panel.js/.css`. The reference feature evidence is the shipped daemon's checkpoint store/diff/rollback wiring, recorded in `analysis/shipped-daemon-features.md`: REA `ev_0a7bdc68255ac1adb7db5fd967eaa355b6bbd1830efb7f12c750d8540dcbbee3`, run:98860 and run:117972. Those observations establish feature presence, not reference runtime behavior or its storage algorithm. This implementation uses new Git plumbing and local fixture proof; it copies no closed-source implementation.

## User workflow

Workspace → Git → Named checkpoints → Create checkpoint asks for a name and saves the on-disk staged index, unstaged files and nonignored untracked files. The index and files remain in place. Checkpoints list names, dates and file counts. Preview restore shows the planned file additions/removals/modifications and the checkpoint's staged/unstaged diffs. Restore opens a separate dialog and requires the exact checkpoint name; merely opening the dialog or entering a wrong name performs no restore. An unsaved editor buffer must be saved/reloaded first.

Restoration automatically preserves the current on-disk state in a named `Before restore: …` checkpoint before replacing files. The protection checkpoint appears in the same list and can itself be previewed/restored. No agent turn or conversation rollback is automatically wired to this operation.

## IPC contract

Existing trusted chrome workspace IPC and panel mount signatures remain unchanged. All actions accept `projectId` and return operation-specific objects:

| Action | Payload | Result |
| --- | --- | --- |
| `workspace:git:checkpoint:list` | `{projectId}` | `{projectId,checkpoints:[{id,name,createdAt,head,files,bytes}]}` |
| `workspace:git:checkpoint:create` | `{projectId,name}` | `{projectId,checkpoint}` |
| `workspace:git:checkpoint:preview` | `{projectId,id}` | `{projectId,checkpoint,expectedState,changes:[{path,kind}],stagedDiff,worktreeDiff}` |
| `workspace:git:checkpoint:restore` | `{projectId,id,expectedState,confirm:true}` | `{projectId,checkpoint,backupCheckpoint,restored:true}` |

`expectedState` is an opaque SHA-256 binding the selected checkpoint's trees/index and the current HEAD, exact index bytes/permissions and all in-scope worktree bytes/Git executable bits. Changing the target or worktree/index after preview invalidates it. `confirm:true` is an additional API check; it is not proof of a human gesture, so the host must keep this API confined to trusted chrome and the explicit UI flow.

`workspace:snapshot.capabilities.checkpoints` is true. Change events use `checkpoint-created` and `checkpoint-restored` (`id`, plus `backupId` for restore). The existing Workspace UI consumes the new actions directly; no main, preload, renderer, AgentService or RPC changes are included in this delivery.

## Storage and safety

Each checkpoint is a commit under `refs/vek/checkpoints/<UUID>`, separate from branch refs and `refs/stash`. Its tree keeps a JSON manifest, the exact index file as a blob, the index tree, and a worktree tree containing raw file blobs. All content is reachable from the checkpoint ref, including staged-only data; an actual `git gc --prune=now` fixture proves it survives collection. HEAD/branch/user stashes remain unchanged. Checkpoint commits may be visible in Git tools that show all refs.

The service copies the index into a temporary independent `GIT_INDEX_FILE` to construct trees. The user's index is never used as scratch storage. `hash-object --stdin`, `update-index --index-info` and other commands use argv/input pipes without a shell; worktree bytes are hashed without checkout/add filters. Diff disables external diff and textconv. Inherited `GIT_*` environment overrides are removed.

Creation, preview and restore serialize with other Workspace writes and obtain an exclusive `index.lock`. Cleanup checks lock inode/device identity, so it cannot remove a new Git lock acquired after the restore publishes its index. Capture rechecks file/index state before publishing a checkpoint; restore checks it before staging replacement work. Every path must be canonical, repository-relative, and have regular-file/directory components with no symlinks, traversal or `.git` access. Git storage aliases/common directories outside the repository are refused.

Restore preflights destination collisions, validates captured blob SHA-256/tree bindings and tests the saved index in an independent file. It preserves a protection ref, moves originals to a private transaction directory, installs new bytes with exclusive hard-link creation, and publishes the saved index atomically at the end. An ordinary failure rolls back actual file moves. If concurrent writes prevent a complete rollback, it retains originals in the transaction directory and reports that path and the protection checkpoint instead of deleting them. A real late-file-collision fixture proves unrelated concurrent bytes and the old index survive the failure.

This is not an atomic multi-file filesystem snapshot. Other editors should be quiescent during restore. Git index locking and optimistic content checks cover normal concurrent changes, but do not prevent a hostile process with write access from continuously renaming repository directories. A process/power interruption can leave a partial worktree; the protection ref and transaction originals provide recovery data, without automatic crash rollback. No permanent checkpoint deletion is exposed.

## Explicit limits

- Existing HEAD commit and a regular repository-local `.git` directory are required. Linked worktrees, external common Git directories, split indexes, sparse checkout/indexes, unmerged entries, active merge/rebase/cherry-pick/revert, submodules and symlinks are refused.
- Restore requires the same HEAD as the capture and does not move branches or rewrite history. File-to-directory topology conflicts and ignored/unmanaged destination files are refused.
- At most 2000 in-scope file paths, 2 MiB per worktree file, 32 MiB total worktree content, 16 MiB raw index, and 1000 checkpoints including protection snapshots. Oversized repositories fail without truncating snapshots. Diff output keeps the existing 4 MiB command limit and can refuse unusually large patches.
- Nonignored untracked files are included; ignored files and empty directories are not. Full raw file bytes, the exact Git index, and Git executable modes are restored. Filesystem timestamps, ACLs, xattrs, hard-link relationships, and non-Git permission distinctions are not snapshot metadata.
- Unsupported filename encoding, directory aliases and unsafe paths are refused. No remote Git command, push, pull request, paid model or account action is performed.

## Verification

`node --test tests/workspace-checkpoint.test.mjs tests/workspace-service.test.mjs` exercises real temporary Git repositories. The checkpoint cases prove exact staged blobs and raw index bytes, unstaged content, untracked binary bytes, staged deletion, executable mode, index flags, unchanged branch/stash/index on capture, explicit/fresh/target-bound preview, recovery by the protection checkpoint, restart/GC persistence, external symlink refusal, ignored collisions, merge/submodule/split-index rejection, rollback after a real late file collision, and preservation of another process's newly acquired index lock. Existing Workspace fixture assertions remain intact.

Raw result: `reports/workspace-checkpoint-tests.log` (final count/duration below). An independent hidden Electron probe used the actual Workspace panel, actual service and a temporary real Git repository. It verified named creation, preview, no restore on opening confirmation/wrong name, and confirmed restore using the expected fingerprint; it checked the resulting actual file bytes. Raw result: `reports/workspace-checkpoint-ui.log`; screenshot `reports/workspace-checkpoint-ui.png`. That probe was run from `/tmp/vek-checkpoint-ui.cjs` without modifying application entry points or dependencies. It is component evidence, not a full main-browser integration run.

Final local result: **21 passed, 0 failed, 0 skipped** (10 checkpoint cases + 11 unchanged Workspace cases), **14964.303666 ms**. Electron component probe: **PASS**. Syntax checks of both modified JavaScript modules passed.
