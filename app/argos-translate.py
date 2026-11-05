"""Offline JSON-stdin adapter. Model installation is a separate explicit step."""
import json
import hashlib
import os
from pathlib import Path
import sys

model_dir = os.environ.get("WIEK_TRANSLATION_DATA") or os.environ.get("VEK_TRANSLATION_DATA")
if not model_dir:
    raise RuntimeError("Set WIEK_TRANSLATION_DATA to an installed local model directory")
if model_dir:
    Path(model_dir).mkdir(parents=True, exist_ok=True)
    os.environ["ARGOS_PACKAGES_DIR"] = model_dir
    os.environ["ARGOS_DEVICE_TYPE"] = "cpu"
    # Argos 1.9 archives contain Stanza weights incompatible with modern
    # Stanza. Use the current MiniSBD segmenter and warm it at install time.
    os.environ["ARGOS_CHUNK_TYPE"] = "MINISBD"
    for variable, folder in [("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_CONFIG_HOME", "config")]:
        os.environ[variable] = str(Path(model_dir).parent / folder)

if len(sys.argv) > 1 and sys.argv[1] == "install":
    import re
    import socket
    # urllib's upstream downloader otherwise has no connection/read timeout.
    socket.setdefaulttimeout(30)
    if len(sys.argv) == 2:
        selected = ["en-zh", "zh-en"]
    elif len(sys.argv) == 4 and sys.argv[2] == "--pairs":
        selected = sys.argv[3].split(",")
    else:
        raise ValueError("Use install [--pairs en-zh,zh-en,en-es,es-en]")
    if not 1 <= len(selected) <= 20 or len(set(selected)) != len(selected) or any(not re.fullmatch(r"[a-z]{2,3}-[a-z]{2,3}", pair) or len(set(pair.split("-"))) != 2 for pair in selected):
        raise ValueError("Invalid translation language pairs")
    import argostranslate.package
    argostranslate.package.update_package_index()
    packages = argostranslate.package.get_available_packages()
    # Resolve every requested direction before downloading any weights.
    resolved = []
    for pair in selected:
        source, target = pair.split("-")
        package = next((p for p in packages if p.from_code == source and p.to_code == target), None)
        if package is None:
            raise ValueError(f"No direct Argos model available for {pair}")
        resolved.append((source, target, package))
    manifest_path = Path(model_dir).parent / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    for source, target, package in resolved:
        downloaded = package.download()
        argostranslate.package.install_from_path(downloaded)
        record = {"installed": f"{source}-{target}", "version": package.package_version, "sha256": hashlib.file_digest(open(downloaded, "rb"), "sha256").hexdigest()}
        manifest = [row for row in manifest if row.get("installed") != record["installed"]] + [record]
        temporary = manifest_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(manifest, indent=2))
        temporary.replace(manifest_path)
        print(json.dumps(record), flush=True)
    import argostranslate.translate
    samples = {"en": "Hello world.", "zh": "你好世界。", "es": "Hola mundo.", "fr": "Bonjour le monde.", "ja": "こんにちは世界。", "de": "Hallo Welt."}
    for source, target, _package in resolved:
        text = samples.get(source, "Hello world.")
        argostranslate.translate.translate(text, source, target)
else:
    # Installation warms required segmenters. Inference fails closed if any
    # dependency attempts to download another resource.
    import socket
    def offline(*args, **kwargs):
        raise RuntimeError("Translation inference is offline; install required resources first")
    socket.socket.connect = offline
    socket.create_connection = offline
    request = json.loads(sys.stdin.buffer.read(131072))
    import argostranslate.translate
    languages = argostranslate.translate.get_installed_languages()
    source = next((v for v in languages if v.code == request["source"]), None)
    target = next((v for v in languages if v.code == request["target"]), None)
    if source is None or target is None:
        raise RuntimeError("Install the requested Argos language pair first")
    print(json.dumps({"text": source.get_translation(target).translate(request["text"])}, ensure_ascii=False))
