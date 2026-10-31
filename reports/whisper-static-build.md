# Bundled CPU-only Whisper CLI

Built and tested `app/bin/whisper-cli` from the official [whisper.cpp v1.9.4 release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4), commit `927cfce34f31707e17f2bff35c349632fb9e2c3a`. Source checkout is retained at `references/whisper.cpp`.

## Runtime and model artifacts

| Artifact | Identity |
|---|---|
| CLI | Mach-O arm64; 2,537,232 bytes; SHA-256 `507deaba45dea03ea06abe61c4e5536e77c9ac7f6f17f0b4cf662b5d3b84c740` |
| Model | `models/ggml-tiny.bin`; 77,691,713 bytes; SHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| Test WAV | `downloads/voice/jfk.wav`; SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`; matches the pinned repository's `samples/jfk.wav` byte for byte |
| Audio format | 16000 Hz, 1 channel, 16-bit PCM, 11.000 seconds |

The model was copied from the already downloaded file after verifying the requested SHA-256. The public upstream response identifies model revision `5359861c739e955e79d9a303bcbc70fb988958b1` and the same linked SHA/77,691,713-byte size; identity headers are saved in `whisper-model-source-headers.txt`. The converted-model card declares MIT and the upstream project documents its conversion from OpenAI Whisper weights. Sources and the original OpenAI MIT notice are retained under `models/MODEL-NOTICE.md` and `models/WHISPER-MODEL-LICENSE.txt`.

## Static CPU build and dependency verification

`BUILD_SHARED_LIBS=OFF` embeds whisper, ggml, ggml-base, ggml-cpu and the common decoder library. Metal, CoreML, CUDA, BLAS, Accelerate, OpenMP, RPC, backend-DL, system ggml/llama, CURL and SDL2 are disabled. This build targets arm64 / macOS 12.0 with `GGML_NATIVE=OFF`, `GGML_CPU_ARM_ARCH=armv8-a`. Only the CLI target is built; no server or microphone app is launched.

`otool -L app/bin/whisper-cli` lists exactly:

```text
/usr/lib/libSystem.B.dylib
/usr/lib/libc++.1.dylib
```

All non-OS libraries are linked statically. The two OS runtimes remain dynamic, as expected on macOS. There are no Homebrew dylib paths, non-system `@rpath` dependencies, GPU frameworks or OpenMP runtimes. Raw load commands: `whisper-static-load-commands.txt`; direct dependencies: `whisper-static-otool.txt`.

The final copied CLI is ad-hoc signed and `codesign --verify --strict --verbose=2` passed. It is not a notarized or Developer ID-signed distribution. Raw verification: `whisper-static-codesign.log`; structured build identity: `app/bin/whisper-BUILD.json`.

## Real transcription result

Executed the newly built bundled CLI, not the Homebrew binary:

```sh
app/bin/whisper-cli -m models/ggml-tiny.bin -f downloads/voice/jfk.wav -l en -nt -np
```

Exit code **0**, wall time **799.823792 ms**, approximately 0.0727× audio duration. Started `2026-10-30T07:00:45.119Z`, finished `2026-10-30T07:00:45.920Z`.

Raw stdout:

> And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.

Raw stdout/stderr are saved separately as `whisper-static-jfk.stdout.txt` / `whisper-static-jfk.stderr.txt`. `whisper-static-jfk.json` records the exact absolute argv, timestamps, duration, hashes, audio format, toolchain and exit status. No paid API, microphone recording or network inference was used.

## Rebuild and integration

`tools/build-whisper-static.sh` validates the pinned source commit, reuses the same CMake options, builds the CLI and copies/signs it. Configure/build logs are retained in `whisper-static-configure.log` / `whisper-static-build.log`. Toolchain: cmake version 4.2.1; Apple Clang 16.0.0. The rebuild recipe reproduces the configuration, not a promise of byte-identical results across compiler/SDK versions.

The root agent should wire `voice-service` defaults to the bundled CLI and copied model and include both in the packaged app. This worker did not modify main, package.json, or voice-service. The executable is arm64 only; an x86_64 build would require a separate build and validation.

Licenses shipped alongside the artifacts: `app/bin/whisper-LICENSE` (upstream MIT), `app/bin/whisper-THIRD-PARTY-NOTICES.txt` (miniaudio/stb_vorbis decoder notices), and `models/WHISPER-MODEL-LICENSE.txt` (OpenAI MIT). The small multilingual tiny model is convenient for local inference; this single English fixture does not establish accuracy for every language or recording environment.
