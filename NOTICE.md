# Third-party notices

Wiek Browser includes a locally maintained SDK derived from the MIT-licensed public harness at https://github.com/citrolabs/ego-lite, original source commit aecc5831fc5a9ea01a078b632185992a3a7ac448, copyright 2026 CitroLabs. The original license is retained in packages/sdk/LICENSE. This attribution is provenance; the product uses its own Wiek namespace, host, build, state, command and Skill and requires no upstream browser installation or service.

The repository-owned evaluation framework derives from the MIT-licensed public framework at https://github.com/citrolabs/ego-browser-benchmark-framework, commit f566ac293e4e6bd80c4e9b062b5699f04eac41f4. Its license remains at benchmark/framework/LICENSE. Original ordered task bytes and immutable SDK tests are retained as evaluation inputs. They are excluded from the application.

The Electron host, snapshot implementation, local services and UI are independently implemented. Proprietary browser binaries and private services are not included in the application.

The bundled CPU transcription executable is built from ggml-org/whisper.cpp v1.9.4 (MIT), with static decoder dependencies. Source identity, build options and third-party notices are retained in app/bin/whisper-BUILD.json and adjacent LICENSE/NOTICE files. The multilingual tiny Whisper model uses the OpenAI Whisper MIT license; see models/MODEL-NOTICE.md and models/WHISPER-MODEL-LICENSE.txt. Translation models and their Python environment are installed separately.

The Wiek W monogram, orange-to-white tile, white indicator and monochrome tray asset are independently authored under this repository's MIT license. tools/build-brand-assets.mjs uses @resvg/resvg-js 2.6.2 (MPL-2.0) during development; that renderer is not included in the application.
