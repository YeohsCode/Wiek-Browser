# Third-party code

Wiek Browser's agent SDK (`packages/sdk`), original SDK tests, fixtures, and compatibility skills (`skills/ego-browser`) derive from `citrolabs/ego-lite`, commit aecc5831fc5a9ea01a078b632185992a3a7ac448, copyright 2026 CitroLabs, under the MIT License. The original license is retained in `packages/sdk/LICENSE`.

The initial Wiek-specific change to that SDK is the `VEK_BROWSER_INSTANCE_ID` override in `page-ledger.ts`, which binds durable page state to the actual browser host rather than a CLI parent process. Additional modifications, if any, are tracked in `analysis/sdk-changes.md`.

Ego's closed-source browser binaries and shipped daemon are retained only under `downloads/` for analysis and reference testing. They are excluded from Wiek's application package. Wiek's browser host, snapshot implementation, and UI are independently implemented. Wiek is not affiliated with Citro Labs.

Electron and Chromium retain their upstream licenses. The official benchmark repository is retained as a separate reference checkout under its own license.

The bundled CPU transcription executable is built from ggml-org/whisper.cpp v1.9.4 (MIT), with static decoder dependencies. Source identity, build options and third-party notices are retained in app/bin/whisper-BUILD.json and adjacent LICENSE/NOTICE files. The multilingual tiny Whisper model is redistributed under the OpenAI Whisper MIT license; see models/MODEL-NOTICE.md and models/WHISPER-MODEL-LICENSE.txt. No Ego PAK resources, proprietary daemon or reference browser binaries are included in the application.

The optional translation adapter uses separately installed Argos Translate (MIT) and its language packages. Python dependencies and translation models are not committed or bundled. The installer records downloaded model identities; each package retains its upstream license.

Wiek Browser was previously named Vek Browser. Persistent archive identifiers, internal IPC, selected environment names, and historical evidence retain legacy names for compatibility.

Two unmodified upstream GitHub workflow files are stored as `.fixture` test data with SHA-256 identities under `tests/fixtures/upstream-workflows/`; their source is the same pinned MIT ego-lite commit. They are restored only as test inputs and are not published as active repository workflows.

The Wiek W monogram, teal tile, and monochrome tray variant in `app/assets/` are independently authored for this project and distributed under this repository's MIT license. No original Ego logos are used in active app or compatibility Skill assets. `tools/build-brand-assets.mjs` renders these authored SVGs with @resvg/resvg-js 2.6.2 (MPL-2.0), a development-only dependency; the renderer is not bundled in the application. Original upstream compatibility Skill documentation retains its MIT attribution.
