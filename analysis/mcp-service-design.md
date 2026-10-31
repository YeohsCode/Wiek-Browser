# Local MCP integrations and scoped gateway

This is an independent implementation of the feature goals identified in shipped-Ego evidence (`analysis/shipped-daemon-features.md`, sections External MCP and Agent scoped MCP). It does not copy Ego source or claim compatibility with private Ego endpoints/accounts.

## Host integration

```js
const { createMcpService, createBrowserGateway } = require('./mcp-service.cjs');
const resolveScope = async ({projectId,threadId}) => {
  // Resolve IDs from the actual agent/project store; reject mismatched threads.
  // Return null if unavailable. projectPath must be an existing absolute directory.
  return {projectId,threadId,projectPath, browserSpaceId};
};
const browserGateway = createBrowserGateway({
  resolveScope,
  callbacks: {
    listTabs: ({scope}) => scopedBrowser(scope).listTabs(),
    snapshot: ({scope,arguments:a}) => scopedBrowser(scope).snapshot(a.options || {}),
    createTab: ({scope,arguments:a}) => scopedBrowser(scope).createTab(a.url),
    navigate: ({scope,arguments:a}) => scopedNavigate(scope,a.targetId,a.url),
  },
});
const mcp = createMcpService({dataDir, resolveScope, browserGateway, onChange:publish});
```

The browser callback must check ownership and bind `targetId` to the thread's own Space; the MCP module does not know Electron tab inventories. Browser methods require a thread scope, use a fixed capability allowlist, and reject injected `scope`, `spaceId`, or arbitrary method fields in tool arguments. No raw CDP/token callback is exposed by this factory. Optional credential resolution is `resolveCredential(reference, scope) -> string`; by default only `env:VARIABLE_NAME` references resolve, without returning values to callers.

The service returns `{dispatch(action,payload),snapshot(),close(),startGateway()}`. Route only trusted browser-chrome IPC to `dispatch`; it includes process configuration and pairing administration. Put `snapshot()` in chrome state as `mcp` and call `close()` before exiting. The parent Agent service remains unchanged.

## Dispatch contract

| Action | Payload / result |
| --- | --- |
| `mcp:snapshot` | `{}` -> full public snapshot |
| `mcp:integrations:save` | `{id?,name,command,args:string[],scope:{projectId,threadId?},credentialRefs?:{ENV_NAME:'env:REFERENCE'},enabled?}` -> snapshot |
| `mcp:integrations:list` | `{scope?}` -> `{integrations}` visible in scope |
| `mcp:integrations:connect/disconnect` | `{id,scope}` -> snapshot; disconnect can omit scope to stop all instances of an integration |
| `mcp:integrations:remove` | `{id}` -> disconnect all instances and remove config |
| `mcp:tools:list` | `{integrationId,scope}` -> `{tools}` with paginated server tools |
| `mcp:tools:call` or `mcp:tasks:create` | `{integrationId?,scope,name,arguments?:object,timeoutMs?}` -> real task immediately; omit integrationId only for allowlisted `browser.*` methods |
| `mcp:tasks:read/wait/cancel` | `{id,scope,timeoutMs?}` -> task; wait is bounded to 60 seconds |
| `mcp:gateway:start` | `{}` -> snapshot with loopback URL |
| `mcp:pairing:create` | `{scope,name?,integrationIds?:[],browserMethods?:[],ttlMs?,grantTtlMs?}` -> one-time code, expiry and exchange URL |
| `mcp:grants:revoke` | `{id}` -> revoke bearer and cancel that client's active tasks |

Project-wide integrations are visible to threads in that project. Thread-specific integrations require an exact project/thread match. Each requested scope has its own subprocess even when configuration is project-wide. No subprocess state is shared between threads. Scope resolution runs again for operations and authenticated gateway requests, so deleted/moved threads cannot keep working under a stale grant.

Task states are `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, and `interrupted`. Tasks contain IDs, scope, tool name, timestamps, actual result/error and optional client grant ID. Arguments are not persisted. Browser/task results larger than the configured limit are omitted with an explicit truncation error. Up to 32 tasks and 32 server connections may run concurrently. At least the most recent 500 task records and all active tasks are retained.

## Protocol and credentials

Public protocol sources checked for this implementation:

- [MCP 2025-11-25 stdio / HTTP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): UTF-8 newline-delimited JSON-RPC, stdout reserved for messages, HTTP origin validation and loopback binding.
- [MCP lifecycle and version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle): initialize first, supported-version response, then notifications/initialized.
- [MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation): notifications/cancelled references outstanding requests; initialize is not cancelled; late replies are ignored.

The stdio client negotiates versions 2025-11-25, 2025-06-18, 2025-03-26, or 2024-11-05. It supports initialize, initialized notification, ping, roots/list, paginated tools/list, tools/call, tools/list_changed invalidation, and cancellation. Sampling/elicitation or unknown server-to-client requests return method-not-found; they never trigger a paid model request. Invalid JSON, invalid result envelopes and oversized stdout messages disconnect the server and fail pending calls. Request concurrency/message sizes are bounded. Process stop terminates the owned process group, escalating from SIGTERM to SIGKILL after 500ms. Task cancellation is cooperative; a server may ignore protocol cancellation until its process is stopped.

Processes use shell:false, an existing project working directory, explicit argv, a minimal platform environment, and injected credential references. The service never accepts plaintext env/credentials/token configuration fields. Do not embed secrets in arbitrary executable arguments; argv is persistent configuration. Resolved credential values exist only in memory and child environment. Known values, including JSON-escaped forms, are redacted from returned/persisted tool output. Stderr content is not retained at all, avoiding chunk-boundary credential leaks; only the diagnostic byte count is shown. This cannot identify unknown secrets a tool independently discovers or deliberately transforms; tools remain user-configured local programs with OS access.

Persistence uses `<dataDir>/mcp/state.json` and a PID/token lock. Directory/files use 0700/0600, symlink state paths are rejected, writes use atomic rename, and a second live service on the same directory is rejected. Running tasks become interrupted on restart and are never silently replayed. No secret keychain values, pairing codes, or plaintext bearer tokens enter persisted state. Grant token digests are persisted to support revocation and expiration.

## Local gateway

`startGateway()` listens only on 127.0.0.1 using an ephemeral port. HTTP Host must be loopback and Origin-bearing requests are rejected. `POST /pair {code}` exchanges one trusted-UI-generated code once for `{token,grantId,endpoint,expiresAt}`. The code expires after five minutes by default; the bearer expires after one day by default (configurable up to 30 days). Tokens are returned only at provisioning, never in snapshots. `POST /mcp` requires `Authorization: Bearer ...`; revoked/expired tokens fail. The gateway is a local stateless JSON-response subset of Streamable HTTP: initialize/ping/notifications, tools/list and tools/call. GET/SSE streaming is not implemented.

Gateway tools expose actual allowed external-server tools as `external.<integrationId>.<toolName>`, available `browser.*` callbacks, and Vek task lifecycle tools `vek.tasks.create/read/wait/cancel`. Caller-supplied scope cannot override a grant. Task reads/cancellation are restricted to tasks created by that same client grant. `notifications/cancelled` cancels an outstanding direct tools/call with the corresponding request ID. The gateway does not advertise the optional MCP task-augmentation capability; Vek's lifecycle wrappers are ordinary tools. This local bearer/pairing design is not an implementation of public-internet OAuth authorization.

## Browser chrome panel

Load `app/mcp-panel.css` and `app/mcp-panel.js`, then:

```js
VekMcpPanel.mount(container,(action,payload)=>vek.action(action,payload),{projects,threads});
VekMcpPanel.update({mcp:mcpSnapshot,agents:agentSnapshot});
```

`window.createVekMcpPanel(container,invoke,context)` also supports independent mounts and returns `{update,destroy}`. The panel has scope selectors, integration configuration/connect/tools, tool invocation with JSON arguments, task cancellation/result inspection, local pairing and client revocation. It shows references rather than credential values. All server names, descriptions, errors and tool results render as text. A pairing code is transient and cleared when its dialog closes. The host supplies normal change notifications; a Refresh action also fetches current state.

## Verification and scope limits

`node --test tests/mcp-service.test.mjs`: **8/8 tests pass**, using real local fake MCP subprocesses. Tests cover lifecycle/roots/pagination, per-thread process separation and forbidden scopes, credential redaction (including quotes/backslashes and split stderr), no implicit parent-secret inheritance, timeout/cancellation and foreign task reads, malformed/oversized stdout, process exit/reconnect, initialization failures, persistence/lock/recovery, pairing one-time use, bearer/Origin checks, scoped real tool forwarding, browser capability allowlists, request cancellation, and revocation. Full output: `reports/mcp-service-test.log`.

`node tests/mcp-panel-smoke.mjs`: **12 Electron DOM assertions pass**, including scope selection, config validation/save, tool call/cancel status, result text escaping and one-time pairing dialog. `reports/mcp-panel-smoke.png` was visually inspected for readable, unclipped layout. This standalone test does not build or replace the browser SDK.

Outbound HTTP/SSE clients are now implemented in `analysis/mcp-http-design.md`. Not implemented here: OAuth/login flows, an MCP public directory, cloud/published gateway hosting, streaming HTTP responses, sampling/elicitation UI, provider-native credential-store adapters, or proprietary Ego task/account APIs. Credential-store adapters and actual scoped browser callbacks are injected host responsibilities. A standards-compliant arbitrary MCP server may offer capabilities beyond this intentionally bounded tool-focused client.

Snapshot browser gateway accepts `{targetId?:string,options?:object}`; omitted target selects the active scoped page. Target ownership remains a host callback check. See `analysis/service-review-findings.md` for added typed-argument regression coverage.
