> 附件实现已继续补齐；本文中早期“does not implement attachments”的描述已被agent-attachments.md及附件测试结果取代。

# Agent service extensions and evidence

These features are independently implemented in `app/agent-service.cjs` and the integrated `app/agent-panel.js/.css`. They extend the initial design; they do not establish feature equivalence with any closed-source Ego implementation. No private implementation code was copied. The existing project/thread/provider/automation actions and SDK assertions remain intact.

## Transcript and local conversation management

All actions use the `agents:` namespace. Mutation results remain full service snapshots; `threads:read` and `control:read` return one thread. The normal `id` field accepts the existing identifier aliases.

| Action suffix | Payload and actual behavior |
| --- | --- |
| `threads:archive`, `threads:unarchive` | `{id}` changes local archive metadata; does not call a provider's archive API. |
| `threads:pin`, `threads:unpin` | `{id}` changes local rail ordering. |
| `threads:notes` | `{id,notes}` saves plain local notes, including an empty string. |
| `threads:goal` | `{id,goal:string,status:'active'\|'complete'}` tracks a local goal. An empty/null goal removes it. Setting a goal never starts work. |
| `threads:marker:add/remove` | Add `{id,label,messageId?}`; remove `{id,markerId}`. Markers can refer to a recorded message. |
| `threads:fork`, `threads:sidechat` | `{id,title?,messageId?,prompt?}` creates a separate child transcript through the selected source message. Source messages get new ids with source provenance; source runs are not presented as newly executed child runs. Only an explicit prompt starts a process. |
| `threads:edit` | `{id,messageId,content}` changes an existing user message and removes later replies from the current transcript. |
| `threads:resend` | `{id,messageId?,content?}` records a revision, removes the selected user message and later replies, and starts a real new turn with the edited/original text. Without `messageId`, selects the last user message. |
| `threads:rollback` | `{id,messageId,includeMessage?:boolean}` retains history through that message (or before it), with the previous transcript retained as a revision. |
| `threads:model` | `{id,model}` selects a CLI default/explicit model; an empty value restores the CLI default. |

Editing/rollback requires the current run to be stopped. Revisions preserve previous messages. These operations do not undo project files, Git commits, browser actions, paid usage, external messages, or any other side effect. Native thread ids are cleared after a transcript rewrite so the next native turn starts a fresh native conversation from the revised local transcript instead of silently using discarded native context.

The panel exposes archive/pin, notes/goals, bookmarks, fork/sidechat, revision inspection, model selection, and per-message edit/resend/rollback. All provider messages, notes, paths, errors, and approval descriptions render through `textContent`, not injected HTML. `VekAgentPanel.appendDraft(text)` appends text only to the selected conversation draft and returns false if no conversation is selected; it never sends a prompt.

## Native JSON import/export

`agents:export` returns a snapshot plus `exportData:{filename,mimeType,content}`. The native bundle uses `format:'vek-agent-export',version:1` and carries projects, provider argv configuration, messages, bounded run output, metadata/revisions, automations, and proposals. Environment values and authentication material are not collected. It exports conversation data, not project-directory contents.

`agents:import {data}` accepts that JSON object/string with a 32 MiB limit. It validates the native format and references, remaps entity/message ids, preserves marker links, rejects invalid transcript roles, and rolls back the whole import on validation failure. Imported provider commands are disabled and schedules are paused. Imported proposals become pending drafts. No imported executable, timer, or prompt runs automatically. Native provider session ids are not trusted/resumed from import. Project paths can be unavailable on another machine; execution still requires a real existing directory.

The panel calls `agents:file:export/import`; the main-process wrapper owns native save/open dialogs and passes the archive to the service. ZIP import/export and Ego-private archive formats are not implemented or claimed.

## Scheduling, heartbeat memory and proposed tasks

Automation `kind` additionally supports `cron` and `heartbeat`.

- Cron uses a five-field numeric UTC expression (`minute hour day month weekday`) with `*`, lists, ranges and steps. Both Sunday 0 and 7 work. When day-of-month and weekday are both restricted they use the conventional OR matching rule. Invalid expressions fail; dates are searched within a five-year bound. Other timezones, seconds fields and named months/weekdays are rejected rather than interpreted silently.
- Heartbeat uses `intervalMs` (default five minutes) and optional plain-text `memory`. The memory is appended to its actual CLI prompt and persists locally. It is not invented model memory or automatically extracted facts.
- All schedule kinds accept `maxRuns`, `stopAfter`, and `stopOnFailure`. Limits are checked before a scheduled/manual attempt; a maximum counts started runs, not skipped ticks. Reaching a limit/date marks it completed; a provider failure can pause it. Status and stop reason are visible.
- `proposals:create {threadId?,automationId?,title?,prompt,runId?}` creates a pending local proposed task. Without `runId` it is explicitly a manual draft. A provider-sourced proposal must quote text actually recorded in that run's stdout.
- `proposals:accept {proposalId}` explicitly starts a real provider run and records the decision/run id; `proposals:reject` records a rejection without execution. Repeated decisions fail. The panel says **Approve & run** and identifies the source. It does not synthesize autonomous recommendations from arbitrary model output.

The app must be running. This does not install a daemon or OS scheduler. Missed interval ticks coalesce; busy/capacity-limited work is skipped, not queued into a backlog. One-time schedules attempt once. There are no external notifications or account tasks created by the tests.

## Multi-agent control API

| Action suffix | Behavior |
| --- | --- |
| `control:create` | `{parentThreadId?,projectId?,providerId?,title?,prompt?,model?}` creates a child with explicit parent relation and optionally starts its real CLI. Parent project/provider/model/browser-space metadata can be inherited. |
| `control:list`, `control:read` | Lists service state or reads one real local thread. |
| `control:wait` | `{ids:[1..8 thread ids],timeoutMs?}` returns snapshot plus `waitResult:{reason:'settled'\|'timeout'\|'closed',threads}`. It waits for the first target to cease running; timeout is bounded to 60 seconds. Shutdown releases outstanding waiters. |
| `control:steer` | `{id,prompt}` uses native `turn/steer` for an active native Codex turn. For a plain CLI whose stdin/protocol cannot accept steering, explicitly queues a follow-up for the next successful turn. The UI labels this **Queue follow-up**; it does not claim mid-turn delivery. |
| `control:stop` | Stops the owned process/turn and cancels pending queued follow-ups. |
| `control:handoff` | `{fromThreadId,toThreadId?,title?,prompt}` stops the source and sends bounded copied transcript context to the destination/new child. It explicitly identifies this as copied context, not native session migration. |
| `control:approval` | `{id,approvalId,decision:'accept'\|'decline'\|'cancel'}` responds only to an actual pending native request. Plain CLI providers return unsupported. Persistent/session-wide policy grants are not exposed. |

Parent/child relationships, per-thread status, actual stdout/stderr and limits remain visible. This is local process orchestration, not a claim of cloud delegation or shared hidden model state.

## Opt-in Codex app-server protocol

The local bundled executable's `app-server --help`, schema-generation help, and generated protocol schemas were checked. Official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) was read for the handshake, thread/turn lifecycle, native steering, interrupt and approval flow. No account files or credentials were inspected directly.

Discovery adds **Codex native session (opt-in)** disabled by default, with argv `['app-server','--stdio']` and `protocol:'codex-app-server'`. The existing one-shot read-only Codex preset remains unchanged. A generic native fixture provider uses the same transport in tests; no model is invoked.

The adapter performs newline-delimited JSON-RPC over a real child process:

1. `initialize`, then `initialized`.
2. `thread/start` with a read-only sandbox and on-request approval, or `thread/resume` using the id actually returned by a previous native run.
3. `turn/start` for an explicitly submitted user prompt. The first native turn receives local transcript context; resumed turns receive only new input (and the fixed root-owned context prefix), avoiding duplicate history.
4. Streams `item/agentMessage/delta`; a completed item is used only when its deltas were absent. Native token-usage notifications are displayed as provider-reported usage.
5. Native steering sends `turn/steer` with `expectedTurnId`; stop sends `turn/interrupt` with the actual ids and has a process-group kill fallback.
6. Actual command/file-change approval requests produce pending UI cards and await an explicit single-request decision. Unknown server requests fail with JSON-RPC method-not-supported; they are never automatically approved.

The app-server process is per active run; native conversation identity persists and is resumed on subsequent turns. A process exit without `turn/completed` is a failure, not a fabricated successful answer. Approval requests expire on interruption/disconnect. CLI output limits, process ownership, recovery, and plaintext-local-data rules still apply.

A non-paid readiness probe against the real local Codex binary completed **only** `initialize` and an ephemeral, read-only `thread/start`, then shut the process down. See `reports/codex-native-readiness.json`; it records `paidTurnStarted:false`. Actual generation/steering/approval/usage behavior is verified with a local fake JSON-RPC process, not claimed as a real paid/model run.

The adapter currently supports text input and command/file-change approval. It does not implement attachments, arbitrary dynamic tools, every app-server notification, native provider archive/fork/rollback, persistent background app-server hosting, live account/plan limits, prices, or live model-catalog queries. Claude is not installed locally, so no unsupported Claude-native session adapter or fabricated compatibility result is supplied. Model catalogues remain explicit user configuration; usage appears only when real structured provider events contain it.

## Root-owned browser context hook

The constructor accepts synchronous `runContext({thread,project,provider}) -> {env?:Record<string,string>,promptPrefix?:string}`. Environment keys are restricted to `VEK_*`, values must be strings, and the prefix is limited to 32 KiB. The hook is owned by main-process code; UI provider requests cannot directly assign hook environment or the prefix. Neither hook environment nor prefix is persisted as a user message.

Main can supply fixed instructions and local CLI/SDK paths in `VEK_BROWSER_CLI`, `VEK_DATA_DIR`, `VEK_THREAD_ID`, etc. Thread creation optionally records a non-negative `browserSpaceId`, inherited by child/fork/handoff metadata. The service does not automatically create browsing spaces or inject page data. Main owns that integration.

## Verification

- `tests/agent-service.test.mjs`: real local fake CLI subprocesses verify persistence/recovery, output/permissions, stop/capacity/overlap, scheduling, metadata/branches/revisions, inert transactional JSON import, cron calendar matching, heartbeat/proposal execution, root context hooks, structured usage and multi-agent create/read/wait/steer/handoff/shutdown.
- `tests/agent-native.test.mjs`: real fake JSON-RPC subprocesses verify initialize/start/resume, actual streamed deltas without duplication, token events, native steering, interrupt, explicit approval/decline, and disconnect failure. No real account task or paid turn runs.
- `tests/agent-panel.test.mjs`: a real isolated Electron window verifies literal malicious-looking message text, draft-only voice append, advanced dispatch controls, JSON file wrapper actions, proposal decisions and UTC cron form submission. The window exits and its temporary profile is removed.
- The repository-wide `npm test` run passed 53/53 at the recorded integration checkpoint (`reports/agent-extended-all-tests.log`). No upstream SDK assertion was modified by this work. Later root additions may expand the repository-wide count.

These tests establish the implemented local behavior. They do not establish exhaustive Ego parity, a successful paid Codex request, Claude compatibility, or the unimplemented capabilities listed above.
