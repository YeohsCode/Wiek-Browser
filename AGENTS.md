# Wiek Browser

The application and SDK use the independent Wiek runtime contract. No application path may discover, import, install or launch a different browser. Keep app/cli/SDK/Skill outputs free of retired runtime namespaces, commands, URLs and installers; verify the actual packaged output.

Original SDK test inputs live under tests/fixtures/sdk-original with pinned SHA-256 identities. Do not change their bytes or assertions. tools/run-sdk-regression.mjs executes an isolated name-mapped copy against the Wiek build; it must not remove cases, assertions or deadlines. Evaluation uses the repository-owned benchmark/framework and unchanged ordered task identities.

Keep static observations separate from runtime proof. Preserve the capability matrix and current results honestly. The 69 local browser cases are not the 31 online model tasks. Keep third-party copyright and license notices. Do not copy proprietary shipped implementation into app code.

Runtime state belongs under data/ or explicit WIEK_DATA_DIR. RPC is loopback-only, token-protected and rejects origins. Pages receive no privileged chrome APIs. Providers execute argv without a shell. Tests never call a paid model or modify a real website account. Run clipboard/native UI suites sequentially and use isolated fixture profiles.
