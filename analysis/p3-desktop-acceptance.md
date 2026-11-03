# P3 desktop acceptance — Wiek 0.20.1

Independent desktop functionality follows the retained Ego shipped-resource feature ledger. No proprietary implementation was copied. That static inventory establishes the requested surface; the native results below establish Wiek behavior, not Ego native runtime parity.

## Completed behavior

The floating selection toolbar is explicitly enabled and excludes configured application bundle IDs plus Wiek’s own bundle/PID. A listen-only annotated-session CGEvent tap observes mouse-up/key-up metadata; after input it reads only `AXSelectedText` from the current foreground application. It never falls back to `AXValue`, clipboard polling, simulated Copy, or printable keystroke text. Secure/protected controls are skipped. A selected range rectangle anchors the toolbar; the focused control bounds are a fallback, so keyboard selection does not depend on the physical mouse pointer. Negative display coordinates remain valid and the toolbar module clamps against the nearest display work area.

Selection text remains in one in-memory draft for 15 seconds, with source application attribution. Snapshots and activity counters contain no text. Copy, Ask and Translate require an explicit toolbar click. Ask fills an Agent draft; Translate opens the configured translation surface. Neither action automatically sends an Agent prompt. Disable, exclusion, expiry, dismissal, monitor loss or close invalidates the draft. Persisted explicit enablement may resume the selection monitor on application restart; a lost monitor requires explicit Resume rather than reconnecting indefinitely.

Application action recording requires an explicit running application and PID. It records only that scope’s click/scroll/navigation-key geometry. Printable keys are dropped, as are protected controls; navigation keys inside native text input controls are skipped. Target AX geometry is recorded without element text or window titles. Screenshots use a fixed window ID and fixed `/usr/sbin/screencapture -l … -o -x -t png` argv. Foreground bundle/PID checks surround capture, PNG validation precedes storage, and late results after stop/exclusion are discarded. The shared recorder provides bounded events/image bytes, timeline previews and target outlines, JSON export, recoverable delete/restore and interrupted-session recovery. Recording never resumes automatically after restart. Explicit recording screenshots can contain other visible content inside the chosen application’s window; the UI states this before Start.

Monitor JSONL transport requires Ready first, bounds each frame, suppresses stderr, stops malformed output and waits for actual process exit when cancelled. Native permission loss or a disabled event tap stops collection. A one-second parent-PID guard prevents a crashed host from leaving an orphan monitor running. Empty selection notifications no longer cause repeated main-window rerenders when no preview exists.

## Evidence

[Desktop tests](../reports/p3-desktop-tests.log): **30/30**, including **17 actual Electron control checks** with synthetic native adapters. They cover default-off and interactive authority, bounded private drafts, provenance/exclusions/own PID, late result suppression, explicit retry, fixed application recording scope, hard limits, printable-input filtering, export/delete/restore and window-capture foreground checks. These tests do not establish OS capture success by themselves.

[Native audit](../reports/p3-desktop-native-check.json), using only a disposable public fixture and an isolated source Electron host:

- Existing Accessibility, Input Monitoring and Screen Recording permissions were already granted; no OS permissions were changed.
- The real Swift helper read the fixture’s AX selection. The integrated monitor accepted the actual native selection, preserving source/PID/character metadata without a body in the snapshot.
- CUA observed the actual floating toolbar with Translate, Copy and Ask. Clicking Copy delivered the exact public selection through the real toolbar module; [toolbar pixels](../reports/p3-desktop-native-toolbar.png) were captured from that owned window.
- Explicit fixture application recording produced a real click, AX target box and a **65,846-byte native PNG** using the real screen-capture subprocess. [Recorded window](../reports/p3-desktop-native-recording.png) contains only the public fixture. Clicking and typing in the synthetic secure field added **zero** recorded events. Explicit Stop completed.
- The final helper’s added parent-exit guard passed a separate [native check](../reports/p3-desktop-native-parent-check.json): all running applications were excluded during this check, and the helper exited **1,025 ms** after its owner exited.
- All disposable hosts, fixture windows and monitor processes were stopped after QA.

The initial NSEvent global monitor and session event tap registered but did not receive the CUA app-targeted events. Switching to the annotated-session tap fixed observed input. CUA targeting also did not automatically activate the source application; the fixture’s explicit Focus button performs normal application activation. Foreground checks were retained. Copy hid the only toolbar window, so the subsequent CUA observation timed out; its exact callback result confirms completion.

## Reproduction and limits

`npm run build:desktop-native` compiles owned Swift sources. `node tools/create-desktop-qa-fixture.mjs` creates a new disposable app from the installed official Electron distribution and the public fixture source; it never modifies the source Electron app. Its UI provides an explicit Focus button for native QA. Use CUA for actual UI input and choose only that fixture as the recording scope.

Native positive proof used the source host reporting 0.20.0 before the 0.20.1 release build, rather than the final packaged release. The last helper change was the separately verified parent-PID guard. Physical multi-display permutations and actual OS permission revocation were not exercised; deterministic negative-coordinate/loss tests and the native permission checks cover handling. Native Translate/Ask buttons were observed, while this native action proof exercised Copy. Backend translation and composer forwarding have separate product tests. Non-macOS native capture remains unsupported, and no physical sleep, logout, personal account or real private document was involved.
