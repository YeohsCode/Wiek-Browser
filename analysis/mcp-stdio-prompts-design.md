# Scoped MCP stdio and prompt previews

This change follows the public protocol contract and uses an independent implementation. It is separate from feature observations in packaged reference artifacts.

## Protocol evidence

The [2026 stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) defines newline-framed JSON-RPC, per-request metadata and cancellation notifications. The [subscription pattern](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) requires per-ID acknowledgment before events, opt-in filters and explicit cancellation. [Version compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) distinguishes the discovery-based and initialization-based eras. These documents define protocol requirements; they do not establish behavior of any private implementation.

Wiek offers explicit configuration for either era. Existing stdio integrations retain the initialization default; selecting 2026-07-28 uses `server/discover` and per-request version/client metadata without an initialization handshake. Unsupported versions fail visibly. Automatic cross-era negotiation is outside this change.

## Implementation

`mcp-stdio-modern.cjs` demultiplexes long-lived subscriptions on the shared subprocess channel. Each stream owns its ID, requested filter, acknowledgment deadline, cancellation and completion. Invalid acknowledgment, unexpected event types and malformed completion lose only that stream. Invalid framing or UTF-8 disconnects the transport. A modern server request is rejected without exposing client roots or issuing a client response.

The common subscription layer now includes prompt-list changes alongside tools and resources. Every accepted update invalidates only its connection's cached definitions; it does not execute a tool, fetch a resource or retrieve prompt messages. Canceled streams send a stdio cancellation notification. The HTTP binding retains its response-stream cancellation behavior. Ended streams do not reconnect automatically.

`mcp-prompts.cjs` provides paginated prompt listings and previews. Names, argument declarations, required string arguments, roles and supported message content types are checked. Lists are limited to 50 pages, 2,000 entries and 2 MiB. Prompt results are limited to 100 messages and 2 MiB. Repeated cursors, duplicate names, unknown arguments and malformed content fail instead of being silently omitted. Arguments are bounded to 64 KiB.

Returned links and embedded resources are data. No URI is opened and no returned text is run or added to a conversation. Prompt previews are returned directly to the caller and are absent from persisted service state. Existing integration/project/thread scope checks apply before every action. Notifications that race a list read reject it; changes during a preview mark it stale. Connection recovery invalidates all prompt caches and generations.

The existing tool form-review mechanism is reused for explicitly interactive modern stdio tool requests. Only that request advertises form capability. Unconfigured input-required replies fail; they do not grant sampling, filesystem or conversation authority.

## Verification and boundaries

Synthetic real stdio peers cover discovery, metadata, concurrent streams, per-stream acknowledgment, partial filters, invalid frames, strict UTF-8, no unsolicited invalidation, cancellation, stale list races, scoped previews and transient results. Real loopback HTTP peers cover prompt reads across both eras and acknowledged prompt list updates. The Electron fixture exercises protocol selection, actual subprocess connection, list/preview, argument errors, literal script text, list invalidation and disconnect.

The new preview surface is not a prompt execution engine. Sampling, prompt/resource input continuations, automatic downgrade, modern gateway serving, and dynamic client registration remain separate work. No paid model or real website account is used by these fixtures.
