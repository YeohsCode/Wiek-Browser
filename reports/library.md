# Local Library and screenshot editor

Implemented independently from REA feature evidence `ev_c746b1b63234454354fe180d624d455e35d018a7b6219d016262de3385d93883` (browser_host locale 58052–58058 and 58084–58108). This is functional reconstruction from observed feature names; no shipped private implementation was copied.

## Integration

`createLibraryService({dataDir,onChange,capture,activePage,exportImage,openUrl})` from `app/library-service.cjs`. Forward trusted chrome `library:*` IPC to `dispatch(action,payload)`; call `close()` on shutdown. Callbacks:

- `capture()` → `{pngBase64,url,title}` from the active page's `capturePage().toPNG()`.
- `activePage()` → `{url,title,text?}`. Saved page means a URL/title/optional text reference, not a complete offline page archive.
- `exportImage({pngBase64,suggestedName})` → `{saved,path?}`. The host selects a destination using a save dialog; the renderer never supplies a filesystem destination.
- `openUrl(url)` opens a saved URL through the browser host.

Include `app/library-panel.css` and `app/library-panel.js`. `window.VekLibraryPanel.mount(root,invoke)` initializes the panel; `update(snapshot)` accepts a Library snapshot or `{library:snapshot}`. `capture()` opens an unsaved annotation draft and is the native screenshot shortcut entry point after showing/mounting the panel. `openCapture(draft)` accepts an existing capture, and `saveActivePage()` saves the current page reference.

Service actions: `library:snapshot`; `library:collections|groups|tags:create|update|delete|restore`; `library:items:create|update|delete|restore|read|list`; `library:capture`; `library:save-active`; `library:export-image`; `library:open-url`. Mutation results are complete snapshots. Read returns full text or an image `dataUrl`; list returns a filtered snapshot. Snapshot metadata carries no image bytes and only a 200-character text snippet. Filters: collectionId, groupId, tagId, kind, query, includeDeleted, deletedOnly.

Item fields: `{kind:'text'|'page'|'url'|'image',title,text?,url?,collectionId?,groupId?,tags?:string[],pngBase64?|imageBase64?}`. Metadata records and mutations use `id`; group creation/update accepts collectionId. Capture returns `{kind:'image-draft',base64,dataUrl,width,height,mime,title,url}` without persisting an item.

## Behavior and limits

Collections, groups, tags, text, links, page references and images persist in `dataDir/library` with private 0700 directories and 0600 metadata/assets. Deletion is recoverable: metadata and bytes remain available in Trash and restore across restarts. Existing items remain visible in All items when their folder/tag is trashed. A process lock rejects two hosts using the same store; atomic writes and serialized rollback prevent phantom metadata after validation errors. Asset reads verify SHA-256.

PNG imports/capture/export validate structure, CRC and dimensions (80 million pixels maximum); generic imports accept PNG/JPEG/GIF/WebP signatures. Images are limited to 20 MiB; text to 1 MiB; metadata to 50 MiB; 5000 items including Trash and 1000 entries per folder/tag category. No permanent deletion, synchronization, OCR, PDF import, page DOM archive or cloud sharing is implemented.

The canvas editor crops by drag selection and supports rectangle, arrow and text annotations, undo/redo, PNG export, and saving an annotated copy. History retains the original plus up to 11 recent edits. Temporary crop guides are excluded from saved/exported pixels. Imported animated images become a single canvas frame on save. User content is rendered with textContent, not injected HTML.

## Verification

`node --test tests/library-service.test.mjs`: **10 passed, 0 failed, 0 skipped**, 114.604125 ms. Real temporary metadata/image bytes, restart, permissions, filters/group consistency, deletion/restore, PNG CRC rejection, callback isolation, URL validation, host lock, symlink rejection, tamper detection and closed-store rejection. Raw log: `reports/library-service-tests.log`.

`node tests/library-panel-pixel.cjs`: **PASS**, standalone hidden Electron with real DOM/canvas and a temporary Library store. Twelve semantic assertions cover unsaved host capture, rectangle/arrow/text pixels, 240×140 crop, undo/redo dimensions, trusted export, persistent PNG bytes and exclusion of crop guides. It uses the existing Electron dependency, invokes no model and does not launch Vek's main runtime or SDK. Raw log: `reports/library-panel-electron.log`; saved raster: `reports/library-annotation-electron.png`; actual panel screenshot: `reports/library-panel-electron-ui.png`. Both images were visually inspected.

A separate temporary LinkeDOM/native-canvas probe also passed (`reports/library-panel-pixel.log`), but the reproducible Electron test is the primary UI verification. Main application navigation/native menu wiring and active webContents capture are the host's integration responsibility and were not proven by this isolated component probe.
