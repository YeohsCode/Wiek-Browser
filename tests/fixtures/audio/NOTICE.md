# Public speech test fixture

`jfk.wav` is the unchanged sample from ggml-org/whisper.cpp v1.9.4, `samples/jfk.wav` (MIT project license retained as `whisper-LICENSE`).

SHA-256: `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`.

It is the same public speech used by the existing packaged-host transcription assertion. Moving the input from ignored `downloads/voice/` to versioned test fixtures makes a clean CI checkout reproducible; the expected transcript and assertion are unchanged. It is test data and is excluded from the application package.
