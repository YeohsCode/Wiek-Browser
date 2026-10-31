# Ego client resource feature ledger

This investigation extends the retained daemon analysis into shipped Chromium PAK resources. It is a bounded, inert static investigation, not a claim that every UI is enabled or operational. No Ego daemon/client code was executed, no account/credential store was read, and no extracted implementation was copied into Vek app/.

## Identity, extraction and analysis coverage

Target: `downloads/ego/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.13/Resources`.

| Pack | Bytes | SHA-256 | Resources / aliases |
| --- | ---: | --- | ---: |
| resources.pak | 38,161,297 | 198a2161aca71aff88ab0a44b1089103a7d4ed89104d31beadabc233122d1671 | 5875 / 377 |
| chrome_100_percent.pak | 522,391 | ce1eac3fd22820c14f4b8e8dd787bc826f83928401c0b4183c1286fab292b3dd | 315 / 71 |
| chrome_200_percent.pak | 1,002,444 | a96b1ead27d4fc5e62af29901daf3a17171c6318b72bb7bcb71cba2df401a6b9 | 315 / 71 |
| en.lproj/locale.pak | recorded in manifest | recorded in manifest | 12566 / 2258 |

`tools/extract-ego-resources.mjs` validates little-endian version/header, resource/alias tables, monotone offsets, payload bounds and Brotli decoded sizes. It decodes gzip/Brotli resources without executing them. Format authority: Chromium's [data_pack.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/resource/data_pack.cc) and [resource_bundle.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/resource/resource_bundle.cc). Version 5 has a 12-byte header, six-byte resource entries plus a sentinel, and four-byte aliases. The manifest retains original pack identity, resource IDs/offsets, raw and decoded hashes, compression and heuristic content types. Extraction and payload originals remain under `analysis/extracted-ego-resources/`; do not ship them as application assets.

A total of 19,071 non-alias payloads was extracted. resources.pak contains 2972 heuristic JS, 231 HTML and 135 CSS resources, including inherited Chromium WebUI and third-party code. The high-ID 58000+ area includes the custom Ego native strings and Vite/React client assets. Its 451 JS/HTML/CSS assets total 18,787,746 decoded bytes; this is an observed numeric range, not a definitive original build boundary. Type inference and vendor-marker hits are candidate classifications.

New REA 6.5.0 client Evidence: **ev_c746b1b63234454354fe180d624d455e35d018a7b6219d016262de3385d93883**, artifact directory digest **caad45a0c8343f3839dd1c2898905c36ed6526a83dce61d2188c0e13d558e6b8**. Full record: `analysis/evidence/rea-client-pak.json` (~256MiB); bounded identity/limitations summary: `analysis/evidence/rea-client-pak-summary.json`.

Selected exact new source paths: resources/{58200,58201,58203,58524,58614,58639,58696,58707,58794,58796,58802,58836}.js. This is a separate new analysis, not a rerun of daemon Evidence. REA leaves **3310 inventoried files outside selected analysis**. `58836.js` exceeded the parent's remaining semantic-result budget; static/module facts were retained, full semantic coverage was not. Numeric resource names were retained rather than guessing Vite original filenames, so many imports cannot resolve to numeric peers automatically. The auxiliary Acorn index (`tools/inspect-ego-client.mjs`, `analysis/ego-client-static-index.json`) reads 44 bounded client JS resources and 106 custom English locale strings as inert AST/text; it supplements but does not broaden the selected REA graph's coverage claim.

## Entry points and routes

- `resources/58300.html` is the shipped **ego home** entry; line 9 loads `../js/newtab-Cr__i7w8.js`. Its CSS includes task client, file surface, Collections, markdown and newtab styles.
- `resources/58360.html` is the **Welcome to ego(lite)** entry; line 9 loads `../js/welcome-aboard-BUuOU6uo.js`.
- `resources/58198.html` is a separate Mojo WebUI `ego-ai-app` shell importing `app.js`; 58200/58201/58203 carry app/browser-proxy/Mojo bindings. A bridge declaration is not proof of its native handler successfully executing.
- 58614.js contains settings paths `/settings/my-ego/account-management`, `/settings/agent/skills`, `/settings/voice/history`, `/settings/voice/dictionary`, `/settings/my-ego`, `/settings`, and search/fallback routes.
- 58696.js contains `/chatbot/$id`, `/task/$id`, `/settings`, home; 58666.js contains `/collections`. Acorn source offsets and literal locations are retained in the AST index.

## Feature facts and reconstruction requirements

Offsets below are Acorn UTF-16 source offsets within the decoded text, as recorded by the index (not pack offsets or UTF-8 byte offsets) (minified source often occupies one line). English locale IDs are exact resource IDs. “Shipped surface” means UI/bridge material exists; runtime/native/backend availability remains unverified unless separately tested.

| Surface | Retained evidence | Concrete requirement / limitation |
| --- | --- | --- |
| Appearance and tab layout | 58614.js ~28200–35200 and ~59437: theme, horizontal/vertical tab bar, more appearance settings | Persist light/dark/system preference; apply it to actual browser chrome; switch real tab layout, not only a form value. Native full browser font/zoom settings are inherited Chromium UI and need separate implementation scope. |
| Custom keyboard shortcuts | 58614.js 26782–35177; locale58117–58127 | Configure voice/screenshot/clip/chat/switch Space/Space Manager keys; record chords, clear/reset and detect conflicts with system/app shortcuts. Conditional native bridge methods setKeyboardShortcut and shortcut event callback exist in 58639.js ~17755/24804. |
| Selection toolbar | 58614.js ~33203; 58802.js 1494/15048; 58639.js 14624–15622 | Preferences and selected-text actions including translate/copy/ask; native bridge can enable/disable globally or per application bundle ID. This includes OS accessibility integration beyond ordinary browser DOM selection. Translate calls `/api/tools/translate?stream=true`, so a usable replacement needs a real translation adapter, not canned output. |
| Browser/local-file memory and instructions | 58614.js: browser activity/local file toggles and ~60026/60363 skills/instructions | Persist enablement and instructions; actual content collection must be separately scoped and consented. Merely saving an on/off flag is not an implemented memory pipeline. |
| Voice history/settings | 58614.js ~43265–58128: retention, clear/delete, audio download, history feedback, dictionary, languages, style, sounds and system mute | Real transcribe adapter, microphone lifecycle, retained actual recordings/results, deletion/retention and dictionary preferences are distinct features. Permission strings alone do not implement voice. |
| Native browser import | 58707.js 153984-byte onboarding/import client; 58639.js 20012–23421 | Multi-source/profile discovery, native access guidance, bookmark/cookie/password/extension/session/web-data/profile-metadata stages, progress, cancellation and partial-success errors. Plain cookie JSON import is a narrower alternative; do not claim equivalent profile migration. No user source browser was accessed in this investigation. |
| Profile export/data inspection | 58639.js 23421–24476 | beginProfileData/getProfileDataItem/exportProfileData/export status/location/close bridge methods. Actual export schema and native implementation remain unknown. |
| Library/Collections | locale58052–58058; 58666.js /collections; 58639.js 18372–18557 saveTextToCollections | Save selected text/image/page, inspect/manage saved items and Collections UI. This is separate from bookmarks. API/native storage behavior needs independent replacement and tests. |
| Screenshot selection and annotation | locale58084–58108; native takeScreenshotInteractive at 58639.js 29057–29365 | Drag capture plus rectangle/arrow/text annotation, stroke/text sizes and copy/save/attach workflow. Existing page PNG capture alone is not this UI. Native capture/accessibility permissions remain a separate OS surface. |
| Space management | locale58000–58024,58066–58071 | Profile-aware new Spaces; open a Space in a new window; quick switching; pinned Spaces; bulk close/delete distinguishing pinned and active task Spaces; explicit task-stop warning. These facts go beyond native SDK ownership/handoff APIs. |
| Tray/background window lifecycle | locale58111–58112; 58639.js 18010,19211–19741,26564–27298 | Browser can remain in tray after all windows close; native tray chat visibility/activation/count and focused-editable-input queries are present. Full native chat-window behavior is not proved by declarations. |
| Home pinned shortcuts | 58696.js ~93676–109572, key ego.start.pinnedUrls.v1 | Create/edit/delete pinned website shortcuts on home. This is separate from a bookmark list. |
| Action collector | locale58128–58137 | Record actual click/key/scroll telemetry with capture scope, attached screenshot and element/target outlines. Preference strings do not establish native collector implementation/default state; avoid silently enabling capture. |
| On-device models | locale58138–58139 | Toggle says AI models may be downloaded/deleted for built-in features. Only a native settings string was established; model identities, download manager, enablement and working inference are unknown. Do not invent offline-model parity. |
| Chat attachment/results | 58794.js 44268–157429; 58796.js ~28682 | Workspace attachments, skills context, screenshots, preview/download files and artifacts; real task archive/schedule UI. These routes connect to daemon/API surfaces already documented; file preview is not equivalent to executing provider tools. |
| Usage/account/sync | 58614.js 39292–43072 | Cross-device bookmark/history/memory/skills sync, per-task usage and account management are shipped UI labels. Services/authentication/runtime are unverified and may depend on Ego proprietary services; separate these from locally implementable preferences. |
| Memory workspace demo | 58696.js ~27464–37455 | Contains Snapshot/Profile/Journal/Wiki labels and descriptive sample project/persona data. These literals are insufficient to prove a fully active persistent memory product. Mark as UI/demo candidate rather than claiming all backing behavior. |
| Independent interactive terminal | 58836.js “terminal” and unrelated icon/resource labels | Still **unknown**. An icon/name or ACP terminal protocol surface does not prove an interactive PTY panel. No PTY view/implementation was established here. |

## Inherited Chromium resources are not automatic Ego feature claims

The PAK also carries Chromium autofill/passwords/payment/address/privacy/security/extensions/accessibility/system/default-browser/search/reset UI. Branding substitutions such as “Citro Labs Password Manager” and “ego Sync” appear in many stock English strings. Those alone do not prove the corresponding Google-style account infrastructure or every feature is enabled in Ego. A full Chromium distribution's settings and credential stores are not automatically provided by Electron. Vek should keep a separate inherited-browser feature matrix and test actual supported behaviors rather than treating packaged strings as runtime proof.

## Priority local gaps and suggested acceptance

1. Browser preference service plus actual theme/tab-layout/shortcut wiring; verify persistence, conflicting chords and real layout/theme effects.
2. Pin/unpin Spaces, real multi-window lifecycle, bulk close/delete guardrails and tray restore; verify active task stop behavior and pinned exclusions.
3. Library data model and page/text/image save/open/delete; verify real saved content and local storage rather than renaming bookmarks.
4. Screenshot capture/annotation UI; verify exported annotated PNG and cancellation/permission failures.
5. Voice: real configured provider adapter, capture/transcribe/cancel, dictionary/retention/delete/audio-download, no synthesized transcript claims.
6. Local collection/memory pipelines only after the corresponding explicit enablement; preserve provenance and deletion. Storing preference flags/instructions is only an initial subset.
7. Browser import/export remains a larger native compatibility project. Start with a well-specified portable format and honestly retain its narrower scope until real Chromium/Safari profile migration has evidence.

These are functional requirements derived from bounded surfaces. They do not authorize reading private browser profiles, copying proprietary code, or executing recovered commands. Dynamic reachability, default enablement and complete native backing remain follow-up evidence gaps.
