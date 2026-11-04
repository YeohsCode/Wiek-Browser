# SDK changes

Base: citrolabs/ego-lite aecc5831fc5a9ea01a078b632185992a3a7ac448, package/ego-browser, MIT.

- src/page-ledger.ts: runtimeInstanceId first accepts process.env.VEK_BROWSER_INSTANCE_ID, falling back to the unchanged parent-PID logic. The CLI sets this to the host UUID. No test assertions have been weakened or removed.
- Tests, fixture server, and 69-case real-browser runner remain unchanged from upstream. The Vek comparison wrapper selects the CLI via the runner's documented EGO_BROWSER_REAL_E2E_CLI override.

- 0.20.3 `src/page-model.ts`: popup waiters snapshot already-discovered target IDs when armed. A delayed URL/title refresh of an old unobserved popup cannot satisfy a future-popup waiter. The existing general discovery update semantics and all upstream assertions stay intact. `tests/sdk-popup-refresh.test.mjs` reproduces the failure before the change; the same modified SDK is applied to both native Ego and Wiek comparisons.
