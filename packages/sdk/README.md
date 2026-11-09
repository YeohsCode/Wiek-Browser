# Wiek Browser SDK

Independent Wiek runtime for the TaskSpace/Page browser automation API. The local Wiek CLI supplies `globalThis.wiek`; the SDK communicates only with that host. It does not discover or launch another browser.

Build with `npm run build`, validate with `npm run typecheck`, and run `npm test`. The test runner verifies immutable original input hashes and executes an isolated identifier-mapped copy against the Wiek build. No assertions, timeouts or cases are removed.

`WIEK_BROWSER_STATE_DIR` and `WIEK_BROWSER_AGENT_WORKSPACE` select isolated runtime state and site learnings. Wiek CLI sets these to its own data and Skill directories.

Third-party copyright and permission notices remain in LICENSE and the root NOTICE.
