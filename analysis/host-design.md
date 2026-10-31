# Vek desktop host

The desktop host is an independent Electron application. It reuses the upstream MIT agent SDK and supplies the documented native binding contract through a token protected loopback WebSocket RPC service. It contains no Ego artwork or executable code.

## Architecture

`app/main.cjs` owns browser state, Electron sessions, WebContentsView tabs, CDP routing, downloads, permission prompts, and the RPC service. `app/preload.cjs` exposes only the browser chrome state and allowlisted UI actions. The chrome renderer is sandboxed with context isolation and no Node integration. Browsed pages have sandboxing and web security enabled and have a narrow prompt-only preload and no Node integration. No raw Chromium debugging port is exposed.

Each tab uses Electron's `webContents.debugger` transport. Root CDP sessions are represented by `vek-<uuid>` IDs; out-of-process frames use Chromium's genuine flattened child sessions. The host implements page tab Target operations itself to keep real browser tabs synchronized with the task inventory. Other CDP operations go directly to Chromium. The snapshot module receives a `sendCDP(method, params, sessionId)` function and produces the upstream native snapshot shape.

## RPC

Default data directory: `<project>/data`. Override with `VEK_DATA_DIR`. `VEK_NO_RESTORE=1` or `--no-restore` starts without restoring browser.json. Persistent browser identity/session data is under `profile/`; the SDK state directory is managed by the CLI.

The host writes `runtime.json` with mode 0600 containing `{port, token, pid, browserInstanceId, version, wsUrl}`. Clients connect to `ws://127.0.0.1:<port>/rpc?token=<token>`. Browser Origin upgrade requests are rejected. Requests are `{id,method,args,spaceId?}` and responses are `{id,result}` or `{id,error:{message,error_code}}`. The optional `spaceId` sets a request-local context; otherwise the socket's selected space applies. `useTaskSpace` can be maintained synchronously by the CLI and supplied with each RPC.

`sendCDPMessage` returns null after enqueueing the parsed raw CDP command. CDP responses/events arrive as `{event:'cdp',payload:<JSON string>}`. Pre-CDP errors arrive as `{event:'cdp-error',message,error_code}`. `browserInfo` exposes the process-lifetime browser UUID for durable SDK ledgers. `getState` and `shutdown` support local diagnostics and lifecycle management.

## Functional surface

The host supports multiple visible tabs; navigation, back, forward and reload; independent named Spaces; persistent profiles and login storage; agent ownership, user delegation and task completion; progress labels and mouse highlights; bookmarks and history; downloads; JSON cookie import; and unpacked Electron-compatible extensions. Profile names, Spaces, bookmarks, history, and tab URLs are restored from local browser.json. Tabs sharing a profile intentionally share cookies and local storage; task isolation is enforced through separate tab inventories and native ownership gates.

Agent task operations enforce `agent` ownership. Handoff changes ownership to `agentDelegatedToUser`; completion changes it to `user`. `takeOverTaskSpace` resumes delegated tasks; completed user Spaces require `claimTaskSpace`. Keyboard input in an agent-controlled page and browser permission prompts delegate control to the user.

## Current limits

This is a reconstruction of locally observable behavior, not an assertion that the proprietary browser has been reproduced in full. Complete Chrome profile migration, Chrome Web Store installation, Ego account services, a cloud multi-agent service, automatic updates, and proprietary internal services are not implemented. Cookie JSON import and local extension loading are explicit alternatives with narrower scope. Electron extension API compatibility is limited by Electron itself. User mouse and keyboard input hand off agent control, with synthetic CDP input excluded by a short dispatch window; native Chrome-level permission/device UI requires further parity verification.

## Transport fidelity fixes verified against upstream cases

Electron converts nested CDP dictionary values into sorted-key objects. `app/cdp-transport.cjs` requests Chromium deep serialization for value-returning Runtime.evaluate/Runtime.callFunctionOn requests, whose object properties travel as ordered key/value pairs, then decodes them in the host. The original expression executes once. This fixes insertion-order parity without rerunning page actions.

Electron's built-in page prompt handler does not provide Chromium prompt semantics. `app/page-preload.cjs` supplies a narrow synchronous prompt bridge, installed in the page main world through contextBridge. The browser host keeps the calling page blocked and emits the documented Page.javascriptDialogOpening/Closed events; Page.handleJavaScriptDialog supplies the result or dismissal. User-owned pages show the browser chrome input modal. Other page dialogs continue through Chromium. This bridge cannot read files, browser state, or the agent token.

Electron 42 iframe target descriptions expose parentFrameId but omit the compatibility parentId field. The host fills parentId from parentFrameId for iframe targets while retaining Chromium's original metadata.

Focused upstream regression verification after these changes: environment initialization (24 assertions), page complex evaluate (23), Page click hit target (17), and Page JavaScript dialog handling (34) all passed. `reports/host-regression.log` contains the complete 98-assertion run. Independent iframe/OOPIF verification also passed 4 selected cases / 59 assertions in `reports/snapshot-oopif-upstream-e2e.log`.

## Packaging and human browser controls

Development defaults to project data/. Packaged builds use the user's application-data `Vek Browser` directory, matching the installed CLI's discovery path. `VEK_DATA_DIR` always overrides either default. Chromium's profile data lives in that directory's profile/ subdirectory.

Native menus provide location focus, new/close tab, reload, back/forward, page zoom/reset, find/next/previous, and system printing with standard macOS/Windows accelerators. Find uses Chromium's native findInPage API and a browser-chrome input bar. User GUI navigation and tab mutation delegate active agent Spaces before taking action. These additions do not change the CDP automation path.

A subsequent real-Electron serialization probe compares standard CDP by-value results with the ordered transport across 22 cases, including Date/Map/Set, typed arrays and nested typed arrays, own Date properties, undefined, NaN/Infinity/-0, BigInt, cyclic graphs, and single-execution counters for both Runtime entry points. All 22 pass (`reports/cdp-transport-probe.log`). For deep types whose own data Chromium omits, the host serializes the already returned object by identity, preserving standard by-value data while restoring ordinary object key order. It releases temporary remote handles after conversion. Cyclic graphs and nested BigInts use Chromium-compatible protocol failures.

## Native popups and favicon fetching

Popup creation uses Electron's synchronous `setWindowOpenHandler.createWindow` hook and reuses its provided native `options.webContents` in the browser's WebContentsView. Debugger initialization runs after returning the native content to Electron. This preserves Chromium opener/window-proxy relationships and actual Target discovery events. Per-client Space discovery subscriptions forward browser Target events even when their originating discovery session is a different tab from the source page.

The browser requests declared page favicon URLs (or /favicon.ico when none are declared) as real image resources in an isolated renderer world. These requests use the page's profile/session and naturally emit Chromium Network events, including redirects; no Network events are fabricated. Successful same-origin images produce data-URL favicon metadata in native tab descriptors. URL-specific promises deduplicate concurrent favicon updates within a document.

Focused unchanged-upstream verification passes environment initialization (24 assertions), Page popup waiter and URL diagnostic (11), and Page load states (50), for 3/3 selected cases and 85 assertions. Evidence: reports/popup-favicon-regression.log. Initial exploratory hosts that omitted the native webContents reuse were stopped and are not the reported passing run.
