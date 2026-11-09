# wiek-browser-benchmark-framework entry points.
#
#   make setup    Provision and validate the local environment
#   make doctor   Audit the environment without changing anything
#   make serve    Build and start the WebUI and benchmark sites
#   make dev      Start WebUI and benchmark-site development servers
#   make build    Build the WebUI and benchmark sites
#   make install  Install both frontend dependency sets
#   make clean    Remove both build outputs
#
# The Makefile preserves each component's native commands, skips unchanged installs
# and builds by mtime, and manages the local process lifecycle. Running the benchmark
# itself stays on its own entry points (uv run python run_eval.py ...) — make covers
# provisioning and the local service stack, not evaluation.

FRONTEND     := frontend
DIST_INDEX   := $(FRONTEND)/dist/index.html
NODE_MODULES := $(FRONTEND)/node_modules/.modules.yaml
SRC          := $(shell find $(FRONTEND)/src -type f 2>/dev/null) \
                $(FRONTEND)/index.html $(FRONTEND)/package.json \
                $(FRONTEND)/vite.config.ts $(FRONTEND)/tailwind.config.js \
                $(FRONTEND)/postcss.config.js

BENCHMARK_SITES              := benchmark_sites
BENCHMARK_SITES_DIST         := $(BENCHMARK_SITES)/dist/server/index.js
BENCHMARK_SITES_NODE_MODULES := $(BENCHMARK_SITES)/node_modules/.package-lock.json
BENCHMARK_SITES_LOCK         := $(wildcard $(BENCHMARK_SITES)/package-lock.json)
BENCHMARK_SITES_SRC          := $(shell find \
                                  $(BENCHMARK_SITES)/app \
                                  $(BENCHMARK_SITES)/public \
                                  $(BENCHMARK_SITES)/worker \
                                  $(BENCHMARK_SITES)/tests \
                                  -type f 2>/dev/null) \
                                $(BENCHMARK_SITES)/package.json \
                                $(BENCHMARK_SITES)/next.config.ts \
                                $(BENCHMARK_SITES)/postcss.config.mjs \
                                $(BENCHMARK_SITES)/sites-vite-plugin.ts \
                                $(BENCHMARK_SITES)/tsconfig.json \
                                $(BENCHMARK_SITES)/vite.config.ts \
                                $(BENCHMARK_SITES)/.openai/hosting.json

.PHONY: setup doctor serve dev build install clean help benchmark-sites-dev benchmark-sites-serve
.DEFAULT_GOAL := help

help:
	@echo "make setup    Provision the environment (toolchain, deps, credentials, symlinks)"
	@echo "make doctor   Read-only audit of the same checks"
	@echo "make serve    Build, then start the WebUI on :8365 and benchmark sites on :4374"
	@echo "make dev      WebUI :8365 + Vite :5373 + benchmark sites :4374, all in watch mode"
	@echo "make build    Build frontend/dist and benchmark_sites/dist"
	@echo "make install  Install the WebUI and benchmark-site dependencies"
	@echo "make clean    Remove frontend/dist and benchmark_sites/dist"

# Provisioning lives in scripts/bootstrap.sh; these two targets are its make-shaped door,
# so `make help` shows the whole path from clone to first run instead of starting at the
# build. setup passes --no-serve to keep one target to one job — `make serve` is how the
# stack starts. BOOTSTRAP_ARGS forwards the script's own flags, e.g. --skip-frontend.
BOOTSTRAP_ARGS ?=

setup:
	./scripts/bootstrap.sh --no-serve $(BOOTSTRAP_ARGS)

doctor:
	./scripts/bootstrap.sh --check $(BOOTSTRAP_ARGS)

# Reinstall only after pnpm-lock changes; .modules.yaml marks completed installation.
$(NODE_MODULES): $(FRONTEND)/pnpm-lock.yaml
	cd $(FRONTEND) && pnpm install
	@touch $@

$(BENCHMARK_SITES_NODE_MODULES): $(BENCHMARK_SITES)/package.json $(BENCHMARK_SITES_LOCK)
	cd $(BENCHMARK_SITES) && npm install
	@touch $@

install: $(NODE_MODULES) $(BENCHMARK_SITES_NODE_MODULES)

# Rebuild when any source is newer than dist/index.html.
$(DIST_INDEX): $(NODE_MODULES) $(SRC)
	cd $(FRONTEND) && pnpm build

$(BENCHMARK_SITES_DIST): $(BENCHMARK_SITES_NODE_MODULES) $(BENCHMARK_SITES_SRC)
	cd $(BENCHMARK_SITES) && npm run build

build: $(DIST_INDEX) $(BENCHMARK_SITES_DIST)

serve: build
	@echo "WebUI :8365 + benchmark sites :4374 (Ctrl-C stops both)"
	@uv run python -m wiek_bench.webui & webui_pid=$$!; \
	( cd $(BENCHMARK_SITES) && npm run start:harness ) & sites_pid=$$!; \
	trap 'kill "$$webui_pid" "$$sites_pid" 2>/dev/null || true' INT TERM EXIT; \
	wait "$$webui_pid" "$$sites_pid"

dev: $(NODE_MODULES) $(BENCHMARK_SITES_NODE_MODULES)
	@echo "WebUI :8365 + Vite :5373 + benchmark sites :4374 (Ctrl-C stops all)"
	@uv run python -m wiek_bench.webui & webui_pid=$$!; \
	( cd $(FRONTEND) && pnpm dev ) & frontend_pid=$$!; \
	( cd $(BENCHMARK_SITES) && npm run dev:harness ) & sites_pid=$$!; \
	trap 'kill "$$webui_pid" "$$frontend_pid" "$$sites_pid" 2>/dev/null || true' INT TERM EXIT; \
	wait "$$webui_pid" "$$frontend_pid" "$$sites_pid"

benchmark-sites-dev: $(BENCHMARK_SITES_NODE_MODULES)
	cd $(BENCHMARK_SITES) && npm run dev:harness

benchmark-sites-serve: $(BENCHMARK_SITES_DIST)
	cd $(BENCHMARK_SITES) && npm run start:harness

clean:
	rm -rf $(FRONTEND)/dist $(BENCHMARK_SITES)/dist
