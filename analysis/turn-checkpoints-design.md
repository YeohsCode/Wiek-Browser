# Automatic Agent turn checkpoints (Vek 0.4)

This independently implemented extension binds existing local Git snapshots to actual provider runs. Reference feature presence remains the bounded daemon evidence in `shipped-daemon-features.md` (checkpoint/turn-diff/rollback wiring); it does not establish identical Ego storage, UI or runtime semantics. No proprietary implementation was reused.

## Capture and lifecycle

Projects opt in using `agents:projects:checkpoints {id,enabled}`; existing and imported projects stay disabled by default. A protected run reserves its thread/concurrency slot, publishes `phase: preparing`, then captures a before snapshot before creating a provider process. Unsupported repository, file/index limit, Git lock, disk or capture failure fails that run with no executedAt and no provider launch. A user stop during preparation waits for capture to settle and prevents process launch.

The actual subprocess runs with `phase: executing`. Native Codex events associate both the native thread ID and turn ID with the run. After process termination—including failure, stop and graceful app shutdown—the slot stays occupied with `phase: finalizing` until after capture finishes. The final run preserves the real provider outcome; after-capture failure is `partial` with its real error and known before snapshot, rather than changing a successful provider reply into a fabricated successful snapshot. `executedAt`, providerOutcome and snapshot status are separate fields.

Protected turns sharing the canonical project directory cannot overlap, including alias project registrations. Restore leases block new runs and configuration changes in that directory. Stop while finalizing waits without signalling an exited PID. Native close cleanup cannot overwrite a finalizing outcome. Main shuts down AgentService before WorkspaceService so final capture remains available. Follow-ups start only after finalization releases the slot. Disabled projects retain the existing execution path and concurrency behavior.

## Associations and crash recovery

`app/turn-checkpoints.cjs` owns a private 0700 directory and atomic 0600 state file under VEK_DATA_DIR. Records bind project/thread/run UUIDs, canonical path, repository directory device/inode identity and immutable before/after checkpoint references. Up to 10,000 associations and a 16 MiB loaded-state bound are supported; the underlying 1000 Git checkpoint limit is usually reached first. There is no automatic retention deletion.

Before reservation and after-capture transitions persist before their corresponding asynchronous work. Startup marks unfinished associations interrupted and never guesses an after snapshot from current files. Agent startup reconciles local associations back into its existing run records, including a crash between checkpoint persistence and Agent-state publication. A native turn/completed notification does not itself create another snapshot; subprocess finalization is guarded once and repeated after calls return the already completed association.

This is not a multi-store transaction. A crash after a Git checkpoint is created but before its association is saved may leave an unassociated checkpoint in the Workspace manager. No success is inferred from such a ref. The actual hard-stop test kills the owned host process and its owned fixture provider, reopens the saved services, verifies interrupted status with a known before/no after, and confirms that a restore preview is still possible.

Import creates new project/thread/run identities and excludes checkpoint authority. Fork copies messages/attachments, not run snapshots. The coordinator looks up its own local association, never an arbitrary checkpoint ID supplied by an archive or webpage. Replacing a repository at the same path refuses run-based restores; manual Workspace review remains available.

## Diff and restoration

`workspace:git:checkpoint:compare {projectId,fromId,toId}` compares immutable snapshot worktree and index trees. It preserves staging-only changes, binary files, additions/deletions and executable bits using Git's real diff with external diff/textconv disabled. Output retains the existing 4 MiB command bound and can fail explicitly on oversized patches.

Agent actions derive the project and snapshot IDs from the local association:

- `agents:changes:list {id:threadId}` returns local records.
- `agents:changes:diff {id,runId}` compares that turn's before/after snapshots.
- `agents:changes:diff {id,scope:'thread'}` spans the earliest known before and latest known after for that conversation. It can include intervening work; it is not claimed to isolate only that Agent's edits.
- `agents:changes:preview {id,runId,target:'before'|'after'}` returns a current-state-bound preview; default before.
- `agents:changes:restore {id,runId,target,expectedState,confirm:true}` restores actual files/index only after a fresh preview and explicit intent, preserving a protection checkpoint. It never changes the conversation transcript.

The native Agent panel exposes project capture enablement, per-turn snapshot status, turn/conversation file diffs and before/after restore. Restore requires typing the selected checkpoint name, uses the backend expectedState, and displays the returned protection checkpoint. Existing Rollback here remains transcript-only. The latest restore association is retained in the private record. API callers must obtain user intent before file restoration; confirm:true is not evidence of a human gesture.

All existing checkpoint limits remain: normal repository-local .git directory, an existing HEAD, same-HEAD restore, regular nonsymlink files, at most 2000 paths/2 MiB per file/32 MiB content/16 MiB index/1000 refs. Linked worktrees, submodules, split/sparse/unmerged states and unsafe topology are refused. External editors/provider Git commits are not blocked; snapshots include their effects, and changed HEAD prevents before restoration. Ignored files, empty directories, xattrs/ACLs and external side effects are outside this format. File restore is not a process-wide filesystem transaction; inherited protections and limitations are documented in `git-checkpoints.md`.

## Verification

`tests/turn-checkpoints.test.mjs` uses real temporary repositories, actual local subprocess edits and a fake native JSON-RPC peer, with no model calls. Its 11 cases cover staged/unstaged/untracked content, real restore and recovery through its protection checkpoint, stale/cross-turn preview refusal, failure/stop/graceful shutdown, unsupported before capture, after-limit partial capture, project exclusion/restore leases, import/fork boundaries, conservative restart, changed HEAD, cancellation during preparation, native IDs/once finalization, and actual host SIGKILL recovery. Raw log: `reports/v040-turn-checkpoints.log`.

The full local suite and packaged-host integration are recorded separately in `reports/RESULTS.md`; upstream SDK assertions remain unchanged. The 31-task online model benchmark has not been run and is not replaced by these local tests.
