# Vek 0.4 native turn recovery QA

Final packaged macOS ARM64 app, isolated data/v040-native-ui profile and a disposable local Git repository. The only executed provider was a local Node fixture; no model, personal browser profile, microphone or account was used.

1. Through native CUA controls, opened Agents, selected Snapshots off, chose On for this project, and saved. The UI showed Snapshots on.
2. Submitted a prompt to Local checkpoint QA through the real composer. Its actual subprocess changed note.txt, staged different contents, and created created-by-provider.txt. The UI progressed running to completed and showed Turn 1 · completed · complete.
3. Opened View file changes. The native modal showed the real added/modified paths, a worktree patch containing After this turn and an index patch containing Staged by provider. The expanded modal was visually inspected; screenshot v040-native-turn-diff.png.
4. Opened Restore before. The preview showed removal of the created file and modification of note.txt, and required the exact snapshot name. A wrong name left Restore files and index disabled. Disk read at that point confirmed After this turn, staged index Staged by provider, and the created file still present.
5. Entered the exact name and restored. UI showed Files restored and a real Before restore protection checkpoint. Separate filesystem/Git checks proved note.txt AND the index both returned to Before this turn, and the created file was removed. Machine-readable evidence: v040-native-restore-file-check.json; screenshot v040-native-restore-success.png.
6. Stopped the disposable QA host and reopened the normal user-data app version 0.4.0. Its state remains separate from this fixture. Test repositories/artifacts remain only under ignored data/.

This validates the actual UI/IPC/services/filesystem path, not only dispatch shape or a simulated success label. Recovering through the protection checkpoint, stale-preview rejection, failure/stop/native IDs and actual host SIGKILL recovery have separate real-Git service tests.
