# Bundled Whisper tiny model

`ggml-tiny.bin` is the multilingual OpenAI Whisper tiny model converted to ggml format by the whisper.cpp project. It is a real pretrained model, not a placeholder.

- Upstream converter/project: https://github.com/ggml-org/whisper.cpp/tree/v1.9.4/models
- Converted-model repository and MIT model card: https://huggingface.co/ggerganov/whisper.cpp
- Source revision observed in the public download response: `5359861c739e955e79d9a303bcbc70fb988958b1`
- Pinned file URL: https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin
- File bytes: 77,691,713
- SHA-256: `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`
- License: MIT; original model notice: Copyright (c) 2022 OpenAI. Full notice is retained in `WHISPER-MODEL-LICENSE.txt`.
- Original model project: https://github.com/openai/whisper

This is the multilingual `tiny` model, not `tiny.en`. Small-model transcription quality varies with language and recording conditions. The bundled CLI runs inference locally; no API key or microphone capture is involved in the bundled JFK validation. See `reports/whisper-static-build.md` and the raw transcription artifacts for measured results.
