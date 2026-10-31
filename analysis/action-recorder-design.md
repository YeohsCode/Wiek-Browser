# Local action recorder

Independent implementation of the requested local recording goals: click/key/scroll events, post-action screenshots, element boxes, a timeline, native JSON export, and recoverable deletion. Closed-source implementation code was not copied. The task's REA inventory supplies the feature scope; the tests below establish this implementation's behavior, not exhaustive native Ego parity.

## Integration

`createActionRecorder({dataDir,onChange,capture,activePage})` returns `{dispatch,record,snapshot,close}`. `capture({targetId})` must capture that exact page without activating a different target and return `{pngBase64}`. `activePage()` returns `{targetId,url,title}` for the current browser page. Factory creation and app restart never start recording.

The service does not install DOM event listeners. Main and the trusted page preload own event provenance, `isTrusted` filtering, and detecting password/payment fields. Feed `record({...})` only from that trusted boundary; a page-supplied `isTrusted` property is not treated as authorization. The service independently checks recording state, the fixed recording target, and the current target, and rejects unrelated events.

```js
await recorder.record({
  targetId, url,
  kind: 'click', // or 'key' / 'scroll'
  x, y,
  box: { x, y, width, height },
  selector,
  // key events: key, ctrlKey, metaKey, altKey, shiftKey
  // scroll events: deltaX, deltaY
  sensitive: false,
  target: { tagName, type, autocomplete, name, id, opaque: false },
});
```

Only whitelisted geometry/action data is retained. `target`, form `value`, input text/data, clipboard contents, arbitrary page metadata, and capture error text are never copied into recording storage. The service drops password, payment, one-time-code, explicitly sensitive/opaque events and common sensitive input-name patterns. It retains navigation/control keys and ASCII Ctrl/Meta combinations; ordinary printable and composition keys are dropped. Shift/Alt printable characters alone are not recorded. Selectors carrying value/text/credential attributes are omitted. URL username/password, query strings and fragments are removed; data/javascript URLs are not retained.

This is metadata minimization, not screenshot OCR/redaction. An explicitly requested recording's screenshots can contain visible page data, including personal information elsewhere on the page. The panel states this. No screenshots are taken for rejected sensitive/input events, outside an explicitly active recording, or on unrelated tabs. A screenshot result arriving after stop/close or a tab switch is discarded before writing.

## Actions and snapshot

| Action | Result |
| --- | --- |
| `recorder:start {name?,targetId?}` | Starts only the current target; a different requested target fails. Returns snapshot. |
| `recorder:stop` | Stops accepting events immediately, drains accepted geometry, and finishes the session. Returns snapshot. |
| `recorder:list` | Snapshot. |
| `recorder:read {id}` | One complete session with event/image metadata. |
| `recorder:read {id,eventId}` | Session plus `preview:{eventId,pngBase64}` for that one recorded image. |
| `recorder:export {id}` | Snapshot plus `exportData:{filename,mimeType,content}`. Native JSON has `format:'vek-action-recording',version:1`, session metadata and inline PNG base64. |
| `recorder:delete {id}` | Soft deletion: timestamps the session and preserves its local JSON/images. Stops it first when active. |
| `recorder:restore {id}` | Clears soft deletion. It never resumes recording. |

Snapshot is `{version:1,sessions,activeSessionId,recording,limits}`. Sessions include id, name, target, sanitized URL/title, timestamps, status, event metadata, total image bytes, and optional `deletedAt`. Events include id/kind/time, sanitized geometry/key information, `screenshotStatus`, and optional `{image:{id,bytes,capturedAt}}`. Screenshots are not included in normal snapshots; a requested preview transfers one image. Main can wire `recorder:file:export` to a native save dialog and save `exportData.content`.

`window.VekRecorderPanel.mount(root,invoke)` and `.update(snapshot)` render the controls, active/off status, recordings/deleted rail, action timeline, selected screenshot, element box, native JSON export and restore controls. Data renders as text, not injected HTML. The panel does not record automatically on mount, update or preview.

## Limits, ordering and lifecycle

- Hard caps: 200 accepted events, 5 MiB per PNG, and 50 MiB of PNG bytes per session. Lower constructor limits can be used in tests, but cannot raise these caps.
- Default capture interval is 500 ms. Geometry events still appear when an image is rate limited. The service serializes event/capture work and reserves event slots before awaiting, so concurrent feeds cannot exceed the event cap or race the image budget.
- PNG format/signature, base64 size and actual decoded byte size are checked. Capture failures and limits get short status codes; no arbitrary error or page object is persisted.
- Capture timeout defaults to three seconds. Stop/close do not start screenshots for queued events. Outstanding capture data is discarded after stop; accepted geometry can drain without blocking on each queued screenshot.
- On the event cap, the session stops with `event-limit`. Other screenshot limits omit the image while keeping supported event metadata.
- Session JSON/index files and PNG files use `0600`; `recordings/`, `images/`, and per-session image directories use `0700`. Writes use exclusive temporary files, file fsync and atomic rename. Stored session/image paths are generated ids; symlink directory/session/image paths are rejected.
- Closing flushes queued events and marks an active session interrupted. A previously active persisted session becomes `interrupted` on startup, with recording still off. Soft-deletion state survives restart.

Deletion is recoverable and does not reclaim screenshot space. Native export includes explicitly recorded local screenshots, so the exported file should be handled as conversation/page data. ZIP export, import, OCR redaction, video capture, event replay, automatic selection-text capture and background recording are not implemented here.

## Validation

`node --test tests/action-recorder.test.mjs tests/recorder-panel.test.mjs` passed **8/8**, with temporary PNG fixtures and a real isolated Electron panel window. Coverage includes default-off/current-target boundaries, dropped sensitive/printable data, no secret URL/value persistence, concurrent capture serialization/event reservations, capture frequency and hard budgets, file/directory modes, native export, soft-delete/restore across restart, bounded close/hung capture, interrupted recovery, observer failures, literal malicious-looking titles, on-demand screenshot preview, element boxes, and explicit UI dispatch controls. No user page was actually recorded by these tests. The Electron fixture exits and its temporary profile is removed.

Detailed output: `reports/action-recorder-tests.log`.
