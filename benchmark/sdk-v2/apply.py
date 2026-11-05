#!/usr/bin/env python3
"""Install the same, source-identity-checked SDK V2 overlay for either browser."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sha = lambda data: hashlib.sha256(data).hexdigest()


def install(reference: Path) -> dict:
    reference = reference.resolve()
    manifest = json.loads((HERE / "manifest.json").read_text())
    commit = subprocess.check_output(["git", "-C", str(reference), "rev-parse", "HEAD"], text=True).strip()
    if commit != manifest["referenceCommit"]:
        raise RuntimeError(f"Reference commit differs: {commit}")
    dataset = "data/real_world_bench.json"
    original_tasks = subprocess.check_output(["git", "-C", str(reference), "show", f"HEAD:{dataset}"])
    if (reference / dataset).read_bytes() != original_tasks:
        raise RuntimeError("Benchmark tasks differ from the pinned framework commit")
    states = []
    for name, identity in manifest["files"].items():
        digest = sha((reference / name).read_bytes())
        if digest == identity["originalSha256"]:
            states.append("original")
        elif digest == identity["patchedSha256"]:
            states.append("patched")
        else:
            raise RuntimeError(f"Refusing to replace changed reference source: {name}")
    if len(set(states)) != 1:
        raise RuntimeError("Partial overlay detected; restore the two pinned files before applying")
    parser = ROOT / "packages/sdk/node_modules/acorn/dist/acorn.mjs"
    if sha(parser.read_bytes()) != manifest["acornSha256"]:
        raise RuntimeError("Acorn identity differs; restore the locked SDK npm dependencies")
    destination = reference / "ego_bench/browser_tools"
    inputs = {
        "canonical_v2.py": HERE / "canonical_v2.py",
        "_canonical_guard.mjs": HERE / "canonical_guard.mjs",
        "_canonical_control.mjs": ROOT / "tools/benchmark-sdk-v2-contract.mjs",
        "_canonical_acorn.mjs": parser,
        "_canonical_acorn.LICENSE": parser.parent.parent / "LICENSE",
    }
    # Finish every preflight before modifying the reference checkout.
    contents = {name: path.read_bytes() for name, path in inputs.items()}
    if states[0] == "original":
        subprocess.run(["git", "apply", "--check", str(HERE / "adapter.patch")], cwd=reference, check=True)
        subprocess.run(["git", "apply", str(HERE / "adapter.patch")], cwd=reference, check=True)
    for name, content in contents.items():
        (destination / name).write_bytes(content)
    files = {name: sha((reference / name).read_bytes()) for name in manifest["files"]}
    if any(files[name] != identity["patchedSha256"] for name, identity in manifest["files"].items()):
        raise RuntimeError("Patched reference identity verification failed")
    return {"referenceCommit": commit, "datasetSha256": sha(original_tasks), "patchSha256": sha((HERE / "adapter.patch").read_bytes()),
            "patchedFiles": files, "overlayFiles": {name: sha(data) for name, data in contents.items()},
            "modelCalls": 0, "accountActions": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    print(json.dumps(install(args.reference), indent=2))
