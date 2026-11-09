"""`python -m wiek_bench.webui` — start the control console (fail-loud on missing deps)."""

from __future__ import annotations

import argparse

from dotenv import load_dotenv

from wiek_bench.config import load_config


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="wiek-browser-benchmark-framework WebUI console")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    try:
        import uvicorn  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "fastapi/uvicorn are required for the WebUI console. Install them, then retry."
        ) from exc

    cfg = load_config(args.config)
    host = args.host or cfg.webui.host
    port = args.port or cfg.webui.port

    from wiek_bench.webui.app import create_app

    app = create_app(args.config)
    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
