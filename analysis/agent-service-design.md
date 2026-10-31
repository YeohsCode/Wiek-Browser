> 0.2.0已扩展native Codex、多Agent、对话管理/附件和UTC cron等能力；本文是初版设计，新增接口与边界请看agent-service-extensions.md、agent-attachments.md及feature-parity.md。

# Local Agent service implementation

This is an independent implementation of the requested project, thread, provider, and automation feature goals. No closed-source Ego implementation code was copied. Its behavior is defined below; it is not evidence that Ego has the same implementation or every capability described here.

The later [extension record](agent-service-extensions.md) supersedes the original limited scope below for native Codex sessions, multi-agent controls, cron/heartbeat scheduling, transcript management, and import/export.

## Integration contract

`require('./agent-service.cjs').createAgentService({dataDir, onChange, maxConcurrentRuns = 2, maxOutputBytes = 1048576})` returns synchronously with:

- `dispatch(action, payload = {})`: asynchronous request handling.
- `snapshot()`: a detached JSON state object with providers, projects, threads, automations, `runningCount`, and `maxConcurrentRuns`.
- `close()`: stops owned provider processes, records running work as interrupted, flushes state, releases the directory lock, and disables timers.

`onChange(snapshot)` receives persisted state updates, including provider output throttled to at most one notification per 100 milliseconds. Completion and mutations publish immediately. Callback exceptions do not stop provider processes.

All mutation and list actions return the full snapshot. `agents:threads:read` returns one complete thread. Identifiers use `payload.id`; the appropriate `threadId`, `projectId`, `providerId`, or `automationId` is also accepted.

| Action | Payload |
| --- | --- |
| `agents:snapshot` | `{}` |
| `agents:projects:list/create/delete` | create: `{name?, path}`; delete: `{id}` |
| `agents:providers:list/discover/configure/remove` | configure: `{id?, name?, command, args: string[], inputMode: 'stdin' \| 'argv', enabled?}` |
| `agents:threads:list/create/read/rename/delete/prompt/stop` | create: `{projectId, providerId, title?}`; rename: `{id,title}`; prompt: `{id,prompt}`; other mutations: `{id}` |
| `agents:automations:list/create/update/delete/pause/resume/run/stop` | create: `{name?,threadId,prompt,kind:'at'\|'interval',at?:date,intervalMs?:number,status?:'paused'}`; update: `{id,...changedFields}`; other mutations: `{id}` |

Projects register existing absolute directories, resolve symlinks to canonical paths, and do not create arbitrary directories. Projects/providers with attached threads cannot be deleted until those threads are deleted. Thread deletion stops the current run and removes its associated schedules.

## Execution and provider discovery

Provider execution uses `child_process.spawn(executable, argv, {shell:false, cwd:project.path})`. A string command is resolved against the local PATH or supplied absolute path. No shell parsing, expansion, generated command strings, or global configuration changes are performed by the service.

Provider arguments may contain `{prompt}`, `{projectPath}`, and `{threadId}` placeholders (double braces are also accepted). Each replacement stays within its original argv element. `stdin` mode sends the transcript to stdin; `argv` mode requires the prompt placeholder. The transcript contains the user and assistant history for that thread. Each turn launches a fresh CLI process; this service does not pretend to resume the provider's native session state.

Only actual stdout is displayed as an assistant message. Stderr remains a run diagnostic. Exit codes, signals, errors, timestamps, output truncation, and stopped/interrupted status are retained. A failed run without stdout gets a system diagnostic, never a fabricated model reply. The shared stdout/stderr text limit is one MiB per run by default; output beyond the limit is drained and omitted. Stop sends SIGTERM to the owned process group and escalates to SIGKILL after one second. Different threads may run concurrently up to the configured limit; the same thread cannot overlap.

Children inherit the host environment so locally installed CLI authentication can work. The service does not serialize environment variables, read authentication files, return environment values, accept provider environment overrides, or place credentials in presets. CLI stdout/stderr is still provider-produced text and should be treated as local conversation data.

Discovery only executes local CLI help. The current machine's PATH `codex` wrapper fails because its optional platform package is missing. The bundled `/Applications/Codex.app/Contents/Resources/codex exec --help` succeeds. Its verified preset is:

```json
{"id":"codex","name":"Codex CLI","args":["exec","--sandbox","read-only","--color","never","-"],"inputMode":"stdin"}
```

The executable path is discovered locally, not required for portable generic-provider operation. If neither verified Codex executable exists, no Codex preset is added. Claude is not installed on this machine, so this implementation does not invent a Claude argv preset. A user can configure an available CLI explicitly. Availability means an executable exists, not that authentication, a subscription, or a model request has succeeded.

The preset was checked against local `exec --help` and the official [OpenAI non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode): stdin can provide the full prompt, stdout contains the final answer, stderr contains progress, and a read-only sandbox is supported. We did not issue a real model request or modify user Codex configuration. The preset preserves the CLI's normal Git repository check; it does not enable unrestricted access or bypass approvals.

## Persistence and recovery

State lives in `<dataDir>/agents/state.json` (plain local JSON, not encrypted). The directory is mode `0700`, state/lock/temporary files are mode `0600`, and symlink state files/directories are rejected. Writes use a fresh exclusive temporary file, file fsync, atomic rename, and a best-effort directory fsync. A PID/token lock prevents two active services from modifying the same store. A stale PID lock is recovered after its process no longer exists. Malformed state causes an explicit startup error rather than silent replacement.

On startup, persisted running threads/runs become interrupted and get an explanatory system message. They do not automatically replay a previous user prompt. Completed transcript and output survive restarts. Graceful `close()` also marks active work interrupted.

## Scheduling semantics

Schedules support one date (`at`) and an interval (`intervalMs` from 25 milliseconds to one year). All persisted timestamps are ISO UTC. The scheduler exists only while this service/app is running; no OS job, external notification, or background daemon is installed.

- An overdue one-time schedule is attempted once on the next active startup and then marked completed, including a failed/skipped attempt.
- An overdue interval coalesces missed ticks into one attempt and advances to the next future tick; it does not flood a restarted app with catch-up work.
- Busy threads yield `skipped-overlap`; a full global concurrency budget yields `skipped-capacity`. Neither creates a queue or duplicate run.
- Pause disables future ticks and leaves an existing run alone. Resume computes a fresh next interval (or the configured one-time date).
- Run executes once immediately, including a paused schedule, and leaves its schedule timing/status intact. Stop pauses future ticks and terminates only a currently running process owned by that automation.
- Delete unschedules future execution. Use stop before deletion when the current run should also be cancelled.
- The last run id, outcome, error, and attempt timestamp are persisted. CRUD operations never fabricate a successful execution.

## Validation and scope differences

`node --test tests/agent-service.test.mjs` exercises only temporary local directories and a Node fake provider. Coverage includes real child output, argv literal preservation, stderr/failure handling, unavailable providers, stop/overlap/capacity, output bounds, data permissions/locking, atomic persistence/reopen, interrupted recovery, one-time execution across restart, interval overlap skipping, and automation pause/resume/run/stop/update/delete. No user account task, paid model call, real scheduled account activity, or external message is created by these tests.

This subsystem does not implement voice, cloud execution, MCP server management, native Codex app-server sessions, account/subscription management, external notifications, OS/background scheduling, cron syntax, or browser-control injection into provider sessions. Browser automation remains available through Vek's separately implemented SDK/CLI; giving a provider a task does not implicitly grant it an attached page or substitute a model response. Those are explicit remaining differences, not hidden parity claims.
