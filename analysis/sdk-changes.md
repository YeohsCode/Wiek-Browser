# SDK changes

Base: citrolabs/ego-lite aecc5831fc5a9ea01a078b632185992a3a7ac448, package/ego-browser, MIT.

- src/page-ledger.ts: runtimeInstanceId first accepts process.env.VEK_BROWSER_INSTANCE_ID, falling back to the unchanged parent-PID logic. The CLI sets this to the host UUID. No test assertions have been weakened or removed.
- Tests, fixture server, and 69-case real-browser runner remain unchanged from upstream. The Vek comparison wrapper selects the CLI via the runner's documented EGO_BROWSER_REAL_E2E_CLI override.
