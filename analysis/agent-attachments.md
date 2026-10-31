# Agent attachments

This extension independently implements explicit local file attachments for the Agent service and panel. It supplements `agent-service-extensions.md`; it does not claim that a model has inspected a file just because it was attached.

## Main/UI contract

- `agents:attachments:add {id:threadId,path:absolutePath}` also accepts `paths:string[]`. Main owns the file picker (`agents:files:attach {id}`) or an explicitly selected Library screenshot path. Paths are selected files, never shell expressions. The source is read but not modified.
- `agents:attachments:remove {id,attachmentId}` soft-detaches the copied file. `agents:attachments:restore` restores an available copy, subject to the active count limit. Both require the thread to be idle/stopped.
- `agents:attachments:read {id,attachmentId}` validates its owned path and returns a snapshot plus `attachmentData`, including the real copied path. The panel dispatches `agents:files:open`; main should validate with this read action and reveal/open the copied file, rather than accept an arbitrary path from UI.
- Thread metadata is `attachments:[{id,name,mimeType,bytes,storageExt,storedPath,available,createdAt,detachedAt?}]`. User messages record which attachment metadata was actually included in that turn. The panel renders file-name buttons, byte/type information, detach/restore and unavailable status using text nodes.

## Files and limits

Each copied file is limited to **20 MiB**, with **10 active attachments** per thread. A batch is validated/copied transactionally; failure removes only copies created by that batch, with no metadata partially attached and no original deletion.

Copies live at `<dataDir>/agents/attachments/<threadId>/<attachmentId>.<safe-extension>`; directories use `0700` and files `0600`. Generated ids, fixed safe extensions, regular-file checks, bounded reads, source-change checks, and symlink rejection on owned paths prevent path escape or unexpected executable attachment paths. Selected source symlinks resolve to the user's explicitly chosen regular source file. The original source path is not retained in metadata.

PNG, JPEG, GIF, WebP and PDF have matching extension/header checks. Other files must be valid UTF-8 without NUL bytes and are copied with `.txt` storage extension, even when their original name is a script/HTML file. SVG and mismatched image/PDF files are rejected. File-name metadata is separate from the generated storage filename.

Detaching leaves the local copy recoverable; it does not revoke content already given to a provider or rewrite past native context. Thread deletion currently leaves its owned attachment copies on disk rather than deleting selected content implicitly; permanent orphan-file cleanup is not implemented. Fork/sidechat copy active files into independent child-owned files. A newly created handoff destination gets copies; a control-created child inherits files only with `includeAttachments:true`.

## Real provider input

Plain CLI prompts receive the actual owned file path, MIME type, original display name and byte count, with explicit wording that contents have not been assumed read. No file content or fake image analysis is invented in the assistant reply.

The native Codex adapter additionally sends each active raster image as a real `localImage` input with the owned path. This input shape was verified against the local generated `UserInput` schema and official app-server protocol. Text/PDF remain real paths and type information for the provider to inspect with its own available tools. A missing owned file causes an explicit error. Imported metadata-only unavailable files are never sent as if they exist.

The local protocol fixture verifies that `turn/start` carries a text item plus a `localImage` item with the correct owned path. No paid image/model request was made by validation.

## Native export/import

Normal `agents:export` includes copied attachment bytes as `inlineBase64` with portable metadata, excluding owned absolute storage paths from attachment descriptors. The existing native JSON format has a **32 MiB total import/export limit**. A legal set of multiple large attachments can exceed that archive limit; export fails clearly instead of silently losing files. `agents:export {metadataOnly:true}` / the panel's **Export without files** button omits copied binary data and marks those files unavailable. Main's `agents:file:export` wrapper must forward this flag.

Import validates base64, MIME/content, declared byte size, 20 MiB per-file and ten-active limits, then writes new owned paths under newly mapped thread ids. It never follows an imported `storedPath` or reads any external file mentioned by an archive. Metadata-only attachments stay unavailable until a user chooses a source again. A failure rolls back new metadata and removes only newly imported file copies. Native archive import additionally caps attachment history entries at 100 per thread as a resource bound. JSON export is not a ZIP/directory archive and does not export arbitrary project folders.

## Validation

`tests/agent-service.test.mjs` now verifies actual temporary image/text copies, contents/permissions, originals unchanged, prompt path/type injection, soft detach/restore across restart, independent fork copies, transactional type failure, the 20 MiB boundary, ten-active/restore limits, portable base64 and remapped paths, malicious external-path import rejection, oversized/count import rejection, and the 32 MiB export/metadata-only fallback.

`tests/agent-native.test.mjs` checks the native local-image wire input. The isolated real-Electron panel test verifies attach/open/detach/restore and metadata-only export dispatch. All Agent-related tests passed **27/27** at this checkpoint (`reports/agent-attachment-tests.log`), with the final UI additions separately passing in `tests/agent-panel.test.mjs`. Every provider execution is a local Node fixture; no paid model call or account task is performed.
