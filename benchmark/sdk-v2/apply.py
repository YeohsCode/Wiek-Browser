#!/usr/bin/env python3
"""Verify the repository-owned evaluation adapter without fetching a browser."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def install(reference: Path) -> dict:
    reference=reference.resolve()
    if reference != (ROOT/'benchmark/framework').resolve():
        raise RuntimeError('Use the repository-owned benchmark/framework')
    required=['wiek_bench/browser_tools/wiek_browser.py','wiek_bench/browser_tools/canonical_v2.py','wiek_bench/browser_tools/_canonical_control.mjs','data/real_world_bench.json']
    hashes={name:hashlib.sha256((reference/name).read_bytes()).hexdigest()for name in required}
    return {'repositoryOwned':True,'datasetSha256':hashes['data/real_world_bench.json'],'files':hashes,'modelCalls':0,'accountActions':0}
if __name__=='__main__':
    print(json.dumps(install(ROOT/'benchmark/framework'),indent=2))
