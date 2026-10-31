# Scheduler timezone and DST (v0.3)

The existing five-field cron scheduler now evaluates calendar fields in a persisted IANA timezone. This is an independent implementation using the runtime's `Intl.DateTimeFormat`; it makes no claim about unverified Ego DST behavior. No dependency, provider preset, account configuration, or paid model call was added.

## API and wiring

The existing `agents:automations:create` and `agents:automations:update` actions accept `timeZone` for `kind: 'cron'`. For example:

```js
{ kind: 'cron', cron: '30 1 * * *', timeZone: 'America/New_York', threadId, prompt }
```

Omitted timezone defaults to `UTC`, including existing persisted schedules. Names are checked by `Intl.DateTimeFormat` and saved as the runtime's resolved name. Invalid names and fixed-offset strings such as `+05:00` return `VEK_AGENT_INVALID_REQUEST`. Numeric fields, lists, ranges, steps, weekday 0/7, and the existing day-of-month/day-of-week OR rule remain supported. `nextRunAt` remains an absolute ISO UTC timestamp. Cron snapshots also include `dstPolicy: 'skip-missing-first-occurrence'`.

No main/preload/renderer/API wiring changes are required: the current dispatch path passes the payload through. The Agent panel's cron editor offers runtime-supported timezone names, with UTC, the current local zone, and a saved valid alias included. Cron cards display the chosen timezone, next run in that zone, DST policy, and any scheduling error. Older payloads retain UTC behavior. The exported source helper is backward compatible: `nextCronAt(expression, after = Date.now(), timeZone = 'UTC')`.

## Clock policy

- Spring forward: a scheduled civil minute that does not exist is skipped; `02:30 America/New_York` does not shift to `03:30` on the transition date.
- Fall back: a repeated civil minute runs only at its first absolute occurrence. Once that first occurrence is in the past, recomputing/resuming a schedule never selects its second occurrence. An every-minute cron consequently skips the repeated local hour.
- A previously persisted overdue occurrence can still run once on restart. Multiple missed occurrences coalesce to that one persisted due occurrence; there is no backlog replay. The next run is calculated strictly after the current time.
- Explicit **Run now** remains a manual request and may run again in the same minute. Scheduled deduplication does not silently suppress an explicit request.

Fixed New York examples: `30 2 * * *` after `2026-03-08T06:59:59Z` returns `2026-03-09T06:30:00Z`; `30 1 * * *` before the November fold returns `2026-11-01T05:30:00Z`, while recomputation at `2026-11-01T06:00:00Z` returns `2026-11-02T06:30:00Z`.

The search visits at most 1,830 local calendar dates, filtering calendar fields before testing hours/minutes. Candidate instants are round-tripped through Intl. Nearby offsets are sampled over ±48 hours at six-hour intervals, which covers the tested New York, Lord Howe, and Apia transitions and fractional-offset Kathmandu. Results depend on the host ICU timezone database; arbitrary historical transitions shorter than the sampling interval are not exhaustively verified. A valid cron whose next occurrence is outside the search window returns an explicit error instead of an unbounded minute scan. If the window is exhausted while advancing a valid due occurrence, that occurrence runs once and future scheduling pauses with `lastScheduleError` and a visible stop reason. The 2096–2104 leap-day gap exercises this path.

## Persistence and lifecycle fixes

The scheduler now advances `nextRunAt` and persists a reservation before spawning a provider. Cron reservations save a timezone/date/hour/minute `lastScheduledMinute` key, excluding the UTC offset so both sides of a fold share the same logical minute. A duplicate persisted fold minute is skipped even after restart. Associated runs carry `automationReservationId`; startup reconciles run counts from actual saved run records, preserving `maxRuns` across a crash between run creation and count publication.

This is an **at-most-once reservation** policy, not exactly-once execution: a crash after reservation persistence but before spawn can lose that occurrence. It is recorded as `interrupted-before-start` and is not automatically retried. A process that had started is recovered as interrupted; external effects cannot be rolled back. A manual run is available when the user chooses to retry.

Invalid updates compute and validate the replacement before mutating the saved automation. Invalid persisted timezones/cron/timestamps pause that automation with an error rather than preventing service startup. A synchronous failed provider start respects `stopOnFailure`, alongside the existing process-exit policy. Successful schedule edits/resume clear a prior search-window diagnostic. Existing overlap/capacity skips, pause/stop, stop date, maximum run count, at/interval/heartbeat behavior remain in place.

Scheduling still runs only while the Vek application/service is active. There is no OS daemon, wake-from-sleep guarantee, or execution while Vek is closed.

## Verification

`node --test tests/agent-service.test.mjs tests/agent-native.test.mjs tests/agent-panel.test.mjs tests/scheduler-timezone.test.mjs`: **38 passed, 0 failed**. The final schedule-error cleanup was additionally checked by rerunning the 11 timezone tests. `node --check` passed for both changed JavaScript modules.

The 11 timezone tests cover real 2026 New York spring/fall boundaries, minute-cron repeated-hour exclusion, Shanghai weekday evaluation, Kathmandu's 45-minute offset, Lord Howe's half-hour fold, Apia's missing date, leap-day search, UTC compatibility, bounded/invalid errors, timezone persistence and atomic edits, pause/resume, duplicate recovery, reservation-before-spawn ordering, count/maxRuns crash recovery, provider failure pause, saved-invalid-zone recovery, and the bounded future-window lifecycle. Service tests launch actual local Node fixture processes; native protocol regression uses fake transports. A real isolated Electron UI test selects New York, submits its payload, and verifies the displayed DST rule. It quits its owned app and removes its temporary profile. No inference or account task is executed.
