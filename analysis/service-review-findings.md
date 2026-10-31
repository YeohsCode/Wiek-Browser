# Profile, voice, catalog and scoped MCP review

Reviewed `app/profile-import.cjs`, `voice-service.cjs`, `catalog-service.cjs`, relevant `main.cjs` call sites and the scoped browser gateway. No personal browser files, credentials, microphone or installed skills were read in tests. Tests use temporary fixture profiles, synthetic audio bytes and local Node subprocesses.

## Reproduced and fixed

1. **Catalog selection accepted stale entries from another project.** Listing project A cached its entries globally; selecting those IDs under project B still succeeded. `catalog:select` now rescans the requested project and allows only current visible IDs.
2. **A selected project skill could change into a symlink to a file outside the project.** The prompt builder rescanned but kept the old cached entry; its old path passed the project prefix check and `stat/readFile` followed the replacement symlink. Prompt building now uses fresh visible IDs, and `catalog:read` rejects changed symlink/real paths. Legitimate user-installed symlinked skills are still discovered by their resolved path.
3. **Catalog prompt size excluded its headers and measured characters.** The builder now bounds complete source headers plus text to 12000 UTF-8 bytes. This prevents multibyte selections and path metadata exceeding its allocated context budget.
4. **Voice shutdown was not terminal.** A call after `close()` could launch a new subprocess; a concurrent call during close returned an overlap error instead of observing shutdown. Closing now rejects subsequent actions (snapshot remains available) and awaits active transcription settlement and temporary-file cleanup.
5. **Voice retention did not run during normal snapshot use.** The panel uses `voice:snapshot`, while pruning happened only on startup, settings updates or a separate history-list call. Expired transcripts and retained audio could therefore remain visible for the entire browser session. Every snapshot now applies retention.
6. **Timeout scheduled an additional unconditional SIGKILL.** `stop()` already owns a force-kill timer canceled on process close. Timeout had added another uncanceled process-group SIGKILL a second later. The duplicate timer is removed; cancellation retains one bounded shutdown path.
7. **UTF-8 transcripts were corrupted at chunk boundaries.** Decoding each stdout Buffer separately replaced split Chinese bytes with replacement characters. Streaming `StringDecoder` instances now preserve stdout/stderr boundaries. A real subprocess deliberately splits the first character across writes.
8. **Profile importer traversed a symlinked `Network` directory.** Checking `lstat(Network/Cookies)` alone follows intermediate symlinks and could read a file outside the selected profile. Supported files now require the canonical path to equal their absolute path; the explicitly selected profile itself is first canonicalized.
9. **Cookie authority parsing could change host-only origin.** A malformed host such as `good.test@evil.test` became the URL for `evil.test`. Import validates URL hostname/authority and path before constructing cookie metadata; malformed host/path rows produce a counted warning. Cookie URLs use the validated origin, while the path remains an explicit cookie property.
10. **Vault import accepted non-HTTP origins and changed memory before save succeeded.** Non-HTTP(S)/credential-bearing origins are rejected. Import/remove now build a proposed list, atomically save it and only then publish it in memory. A fixture forces rename failure and verifies the old password remains available.
11. **Scoped MCP snapshot lacked optional tab selection.** This is a capability addition, not an ignored existing argument: its old schema correctly rejected `targetId`. The browser gateway now advertises an optional string target ID, validates all declared argument types and still rejects injected scope/space fields. The host checks the requested target belongs to the resolved thread Space.

## Host integration findings

The parent agent owns `main.cjs`; this review did not change that file.

- Browser-activity context originally included recent default-profile history from unrelated user/agent tabs. Reported to the parent and observed corrected to a thread-specific Space set, with titles/paths bounded and query/fragment data omitted.
- MCP snapshot callback now calls `targetFor(s,args.targetId)`, preserving default active-tab behavior and enforcing scoped ownership.
- `catalog:select` should derive `projectId` from the actual selected conversation even when the payload omits it. The module validates the supplied scope; only the host has authoritative thread-to-project membership. Reported to the parent for integration.

## Tests and evidence

`tests/service-review-regression.test.mjs` adds eight focused cases. Initial seven checks failed before fixes (`reports/service-review-before.log`). Final combined execution also runs every existing catalog/voice, profile-import and MCP service test:

```sh
node --test tests/service-review-regression.test.mjs tests/catalog-voice.test.mjs tests/profile-import.test.mjs tests/mcp-service.test.mjs
```

Result: **24 tests passed, 0 failed**, recorded in `reports/service-review-regression.log`. No upstream Ego SDK assertions were changed. This test run does not rebuild the SDK, start a shared browser or touch live profile/keychain data.
