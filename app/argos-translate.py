"""Offline JSON-stdin adapter. Model installation is a separate explicit step."""
import json
import hashlib
import os
from pathlib import Path
import sys

model_dir = os.environ.get("VEK_TRANSLATION_DATA")
if model_dir:
    Path(model_dir).mkdir(parents=True, exist_ok=True)
    os.environ["ARGOS_PACKAGES_DIR"] = model_dir
    os.environ["ARGOS_DEVICE_TYPE"] = "cpu"
    for variable, folder in [("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_CONFIG_HOME", "config")]:
        os.environ[variable] = str(Path(model_dir).parent / folder)

if len(sys.argv) > 1 and sys.argv[1] == "install":
    import argostranslate.package
    argostranslate.package.update_package_index()
    packages = argostranslate.package.get_available_packages()
    manifest = []
    for source, target in [("en", "zh"), ("zh", "en")]:
        package = next(p for p in packages if p.from_code == source and p.to_code == target)
        downloaded = package.download()
        argostranslate.package.install_from_path(downloaded)
        record = {"installed": f"{source}-{target}", "version": package.package_version, "sha256": hashlib.file_digest(open(downloaded, "rb"), "sha256").hexdigest()}
        manifest.append(record)
        print(json.dumps(record), flush=True)
    import stanza
    original_pipeline = stanza.Pipeline
    stanza.Pipeline = lambda *args, **kwargs: original_pipeline(*args, **{**kwargs, "download_method": None})
    import argostranslate.translate
    for source, target, text in [("en", "zh", "Hello world."), ("zh", "en", "你好世界。")]:
        argostranslate.translate.translate(text, source, target)
    Path(model_dir).parent.joinpath("model-manifest.json").write_text(json.dumps(manifest, indent=2))
else:
    # Installation warms required segmenters. Inference fails closed if any
    # dependency attempts to download another resource.
    import socket
    def offline(*args, **kwargs):
        raise RuntimeError("Translation inference is offline; install required resources first")
    socket.socket.connect = offline
    socket.create_connection = offline
    request = json.loads(sys.stdin.buffer.read(131072))
    import stanza
    original_pipeline = stanza.Pipeline
    stanza.Pipeline = lambda *args, **kwargs: original_pipeline(*args, **{**kwargs, "download_method": None})
    import argostranslate.translate
    languages = argostranslate.translate.get_installed_languages()
    source = next((v for v in languages if v.code == request["source"]), None)
    target = next((v for v in languages if v.code == request["target"]), None)
    if source is None or target is None:
        raise RuntimeError("Install the requested Argos language pair first")
    print(json.dumps({"text": source.get_translation(target).translate(request["text"])}, ensure_ascii=False))
