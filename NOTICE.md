# Third-party code

Vek Browser's agent SDK (`packages/sdk`), original SDK tests, fixtures, and compatibility skills (`skills/ego-browser`) derive from `citrolabs/ego-lite`, commit aecc5831fc5a9ea01a078b632185992a3a7ac448, copyright 2026 CitroLabs, under the MIT License. The original license is retained in `packages/sdk/LICENSE`.

The initial Vek-specific change to that SDK is the `VEK_BROWSER_INSTANCE_ID` override in `page-ledger.ts`, which binds durable page state to the actual browser host rather than a CLI parent process. Additional modifications, if any, are tracked in `analysis/sdk-changes.md`.

Ego's closed-source browser binaries and shipped daemon are retained only under `downloads/` for analysis and reference testing. They are excluded from Vek's application package. Vek's browser host, snapshot implementation, and UI are independently implemented. Vek is not affiliated with Citro Labs.

Electron and Chromium retain their upstream licenses. The official benchmark repository is retained as a separate reference checkout under its own license.

The bundled CPU transcription executable is built from ggml-org/whisper.cpp v1.9.4 (MIT), with static decoder dependencies. Source identity, build options and third-party notices are retained in app/bin/whisper-BUILD.json and adjacent LICENSE/NOTICE files. The multilingual tiny Whisper model is redistributed under the OpenAI Whisper MIT license; see models/MODEL-NOTICE.md and models/WHISPER-MODEL-LICENSE.txt. No Ego PAK resources, proprietary daemon or reference browser binaries are included in the application.
