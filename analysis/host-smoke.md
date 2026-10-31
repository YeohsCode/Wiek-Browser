# Host smoke verification

Environment: macOS arm64, project-installed Electron 42.11.18, isolated `VEK_DATA_DIR=/tmp/vek-host-smoke`, `VEK_NO_RESTORE=1`.

The host booted successfully and wrote runtime.json with owner read/write permissions only. The agent CLI connected to the authenticated loopback RPC bridge and ran the copied upstream SDK.

Verified sequence:

1. `taskSpace('bridge-smoke')` created a task Space with canonical p1.
2. `page.goto(data:text/html,...)` navigated a real Chromium page.
3. `page.snapshot()` returned heading, button, and textbox with SDK refs and stable role locators.
4. `page.fill('loc=role:textbox[name="Name"]', 'Alice')` and `page.press(..., 'Enter')` succeeded; `page.evaluate(...)` returned `Alice`.
5. `page.screenshot({path:'/tmp/vek-host-smoke/page.png'})` produced a valid screenshot. Visual inspection confirmed the loaded heading/button and filled input.
6. `task.handOff()` transferred ownership to the user; subsequent native `listTabs()` rejected with `EGO_TASK_SPACE_USER_IN_CONTROL` and reason `manual_takeover`.
7. An authenticated RPC `shutdown` returned true and stopped the earlier smoke host.

An initial screenshot invocation used the wrong API shape (`page.screenshot(path)`) and was correctly rejected by the upstream SDK. Retesting with `{path}` succeeded. During a concurrent SDK rebuild, one CLI invocation observed a temporarily missing dist bundle; this was not a host failure.

This smoke test is supplemental evidence. The upstream real-browser suite and Ego comparison are tracked separately by the primary agent. Snapshot provider frame/shadow/subtree tests are documented by that module's implementation agent.
