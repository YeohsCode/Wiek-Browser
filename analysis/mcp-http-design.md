# Outbound MCP Streamable HTTP client

> 0.17更新：现代资源和显式subscriptions/listen已补齐有界HTTP范围，参见[mcp-modern-subscriptions](mcp-modern-subscriptions.md)。下文缺失项反映0.3时点；MRTR/采样/表单续传等仍未完成。

`app/mcp-http-client.cjs` adds an independent public-protocol HTTP transport to `mcp-service.cjs`. Existing stdio integrations, task/grant scope checks and service dispatch remain compatible. `mcp-panel.js/css` adds HTTP configuration. No main/preload/renderer/API changes are required.

## Configuration and connection contract

```js
await mcp.dispatch('mcp:integrations:save', {
  name: 'Configured remote tools',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  protocolVersion: '2025-11-25', // default; or '2026-07-28'
  headerRefs: { Authorization: 'env:EXAMPLE_MCP_AUTH_HEADER' },
  allowInsecureHttp: false,
  scope: { projectId, threadId }, // thread optional for a project-wide config
});
```

The explicitly referenced environment variable contains the complete header value, e.g. `Bearer ...`. Header values are resolved only during connection using the existing `resolveCredential(ref,scope)` callback; no automatic environment/Keychain/browser-cookie lookup occurs. Outbound HTTP header references require `env:VARIABLE`. Existing stdio `credentialRefs` are unchanged. Plaintext `headers`, `env`, `token` and `credentials` fields are rejected. HTTP configuration rejects process command/argv fields.

The same `mcp:integrations:connect/disconnect/remove`, `mcp:tools:list`, `mcp:tasks:create/read/wait/cancel` actions operate on either transport. Each project/thread connection has an independent remote session or protocol context. The real tools and actual results still pass existing scope/credential-redaction/persistence rules. Main's scope resolver remains authoritative.

The HTTP endpoint permits HTTPS with normal certificate validation. Explicit `allowInsecureHttp:true` permits HTTP only for `127.0.0.1`, `[::1]`, or `localhost`; localhost resolution is pinned to 127.0.0.1. Remote plaintext HTTP, URL userinfo/query/fragment and redirect following are rejected. No ambient proxy settings, cookie jar, forwarded browser profile credentials or TLS-disable configuration are applied. Routing, protocol, cookie and hop-by-hop headers cannot be supplied through header references. Unknown certificates fail, including when the caller supplies an ignored `rejectUnauthorized:false` field.

`HttpClient` is also exported for bounded standalone testing, using `{config,cwd?,credentials?:resolvedHeaderMap,timeoutMs?,maxMessageBytes?,onChange?}`. The service is the normal entry point; direct callers must still enforce task scope. Direct credentials are transient headers, never persisted by this class.

## Explicit protocol modes

Official latest documentation was checked and redirected to revision **2026-07-28**. This changes the transport substantially. The implementation exposes a deliberate mode selector rather than silently retrying a potentially mutating tool call under another protocol.

The default `2025-11-25` mode uses initialize/initialized, negotiated protocol headers, optional session headers, GET notifications and DELETE cleanup. It accepts legacy negotiation down to 2025-06-18 or 2025-03-26. Resumable request streams use GET/Last-Event-ID and server retry intervals. A session 404 triggers fresh initialization but fails the original operation explicitly; tool POSTs are not replayed. Background notification GET streams are optional at the server (405 is accepted).

The `2026-07-28` mode uses server/discover and per-request metadata, with required method/name and annotated parameter headers. It sends no legacy initialization, session, GET, DELETE or cancellation notification. Cancellation closes the response stream. Tool schemas with invalid header annotations are excluded with a visible diagnostic count. Unicode, control characters, padding and sentinel-shaped header values are base64 encoded. Version errors are surfaced for the user to choose a compatible mode; automatic era/version fallback is not implemented.

Primary normative sources, with corresponding-era behavior kept separate:

- [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
- [2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [per-request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [additional-input results](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).

## Resource and lifetime bounds

- Default JSON message/event/request limit 1 MiB; SSE response stream limit eight times that. At most 1000 data events per response, 64 pending calls, 32 user-configured headers, and bounded IDs/retry delays.
- Streaming UTF-8 decoder rejects malformed bytes and handles characters split across network chunks. SSE parses CRLF/LF/CR, comments, multiline data, event IDs and retry fields. Unknown JSON-RPC structures fail through the existing protocol validator.
- Original per-request deadlines cover network reads, replay-stream GETs and retry delays. Abort removes pending handlers, sends a legacy cancellation notification where applicable, and destroys the actual request stream. Late replies cannot complete cancelled tasks.
- Resume is limited to five GET attempts. Standalone legacy notification streams rotate after 30 seconds and obey bounded retry intervals. No automatic tools/call replay occurs.
- Stop aborts active HTTP operations and notification streams, waits for cleanup, attempts legacy session DELETE with a 1.5-second ceiling, clears credentials/session and destroys the connection agent. Disconnect/reconnect uses a fresh client. Response diagnostic bodies are not retained in HTTP status errors.
- Session IDs and known resolved header secrets, including bearer token content, are redacted from returned results. Config/state contains references only. As with stdio, unrelated secrets independently produced by an external tool cannot be identified automatically.

## Panel and capability limits

The existing Connected tools panel adds **Add HTTP server**, protocol version, endpoint URL, header-reference JSON and explicit loopback HTTP choice. Configuration opens again with saved references; process integration configuration remains unchanged. Labels distinguish HTTP endpoints from local executable arguments. All values/results still use text DOM rendering.

No OAuth browser/login flow, arbitrary remote HTTP authentication discovery, paid model call, personal service request, 2024 split HTTP+SSE transport, automatic proxy, public server directory or remote profile synchronization is implemented. HTTP clients expose no project-root filesystem path. Sampling/elicitation are not advertised. Modern MRTR additional-input results fail explicitly rather than being presented as completed tools; subscriptions/listen and MRTR continuation UI are not implemented. This is a tool-focused subset, not a claim that every capability in the latest MCP revision is complete. The existing local paired gateway remains its documented JSON-response subset.

## Verification

```sh
node --test tests/mcp-http-client.test.mjs tests/mcp-http-modern.test.mjs tests/mcp-http-panel.test.mjs tests/mcp-service.test.mjs
node tests/mcp-panel-smoke.mjs
```

**25/25 tests pass**, including the original eight stdio tests; full raw output in `reports/mcp-http-test.log`. Twelve HTTP tests use actual temporary loopback servers (one temporary self-signed HTTPS server), covering real lifecycle and headers, JSON/SSE, split Chinese UTF-8, CRLF and server messages, cursor resume without POST replay, cancellation/timeout and stream teardown, session recovery, malformed/oversized bodies, TLS/redirect/auth rejection, scoped credential references, independent thread sessions, background notification cache invalidation, concurrent response correlation, stop/reconnect and the pinned localhost resolver. Four modern tests validate per-request metadata/mirrored headers, invalid schemas, header encoding, cancellation and unsupported-input handling.

The Electron HTTP configuration test passes eight internal assertions through real sandboxed IPC/service actions. `reports/mcp-http-panel-test.log` contains expected rejected-configuration diagnostics plus the success record, and `reports/mcp-http-panel.png` was visually inspected. The original panel smoke retains its twelve assertions and passes (`reports/mcp-panel-smoke.log`). These tests do not rebuild the SDK or connect to any personal/paid service.
