# wiek-benchmark console (frontend)

Vite + React + TypeScript SPA for the WebUI control console. Complex config forms use
**antd Form**; layout follows the Swiss International Style via Tailwind. Built `dist/`
is statically served by the FastAPI backend (`wiek_bench.webui`).

## Dev

```bash
cd frontend
pnpm install
pnpm dev        # http://localhost:5373, proxies /api + /runs → 127.0.0.1:8365
```

Start the backend separately:

```bash
uv run python -m wiek_bench.webui   # http://127.0.0.1:8365
```

## Production build

```bash
cd frontend
pnpm install
pnpm build      # → frontend/dist, served by FastAPI at /
```

## Layout

- `src/components/ConfigForm.tsx` — provider / run / sampling / limits / judge + dataset select (antd Form).
- `src/components/RunsPanel.tsx` — run list, live progress drawer, stop, session/compare export.
- `src/api.ts` — typed fetch wrappers for the backend REST API.
