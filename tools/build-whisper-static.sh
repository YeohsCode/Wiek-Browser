#!/bin/sh
set -eu
vek_build_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
vek_whisper_source="$vek_build_root/references/whisper.cpp"
vek_whisper_build="$vek_build_root/tools/whisper-static-build"
vek_whisper_commit=$(git -C "$vek_whisper_source" rev-parse HEAD)
if [ "$vek_whisper_commit" != '927cfce34f31707e17f2bff35c349632fb9e2c3a' ]; then
  echo 'Expected official whisper.cpp v1.9.4 commit 927cfce34f31707e17f2bff35c349632fb9e2c3a' >&2
  exit 1
fi
cmake -S "$vek_whisper_source" -B "$vek_whisper_build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DWHISPER_BUILD_IS_DEV=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_USE_SYSTEM_GGML=OFF \
  -DWHISPER_USE_SYSTEM_LLAMA=OFF \
  -DWHISPER_CURL=OFF \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_COREML=OFF \
  -DWHISPER_OPENVINO=OFF \
  -DGGML_BACKEND_DL=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_CPU_ARM_ARCH=armv8-a \
  -DGGML_METAL=OFF \
  -DGGML_BLAS=OFF \
  -DGGML_ACCELERATE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_CUDA=OFF \
  -DGGML_RPC=OFF \
  -DGGML_CCACHE=OFF
cmake --build "$vek_whisper_build" --config Release --target whisper-cli --parallel 4
mkdir -p "$vek_build_root/app/bin"
cp "$vek_whisper_build/bin/whisper-cli" "$vek_build_root/app/bin/whisper-cli"
chmod 755 "$vek_build_root/app/bin/whisper-cli"
codesign --force --sign - "$vek_build_root/app/bin/whisper-cli"
codesign --verify --strict --verbose=2 "$vek_build_root/app/bin/whisper-cli"
otool -L "$vek_build_root/app/bin/whisper-cli"
