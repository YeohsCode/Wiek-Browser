# Wiek Browser

Keep the public SDK's upstream test assertions and fixture semantics intact. SDK-specific conventions remain in references/ego-lite/AGENTS.md. Wiek's app/ files are independent implementations; do not copy closed-source shipped code into them.

Use REA evidence for claims about the reference browser and distinguish source presence, static inference, and runtime proof. Keep analysis/feature-parity.md and reports/comparison.md honest about missing, skipped, failed and unrun behavior. Do not equate the 69 local deterministic cases with the 31 live-site model benchmark.

App/CLI runtime data belongs in data/ or an explicit VEK_DATA_DIR, never in tracked source. Keep RPC loopback-only, token-protected, with origins rejected. Remote pages must not receive privileged browser chrome APIs. Agent providers run argv without a shell; no test may invoke a paid model or alter a real website account.

Do not run SDK builds concurrently with reference-browser E2E. The native reference host reads that bundle on each invocation.
