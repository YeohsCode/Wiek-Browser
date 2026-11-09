// Thin fetch wrappers for the FastAPI console backend.

export interface DatasetInfo {
  name: string;
  count: number | null;
  categories?: Record<string, number>;
  // Task id and category feed the new-run task selector.
  tasks?: { task_id: string; category: string }[];
  error?: string;
}

export type ReportLocale = "zh" | "en";

export interface SingleReportOptions {
  exclude?: string[];
  locale: ReportLocale;
}

export interface RunInfo {
  run_id: string;
  // Persisted parent relation for WebUI-derived runs. Present on rejudge children;
  // null for base runs and metadata written before derivation provenance existed.
  derived_from: string | null;
  benchmark: string | null;
  provider: "pi" | "codex" | null;
  browser_tool: string | null;
  model: string | null;
  completed_at: string | null;
  // cancelled=true means the run stopped mid-flight and enables resume;
  // concurrency prefills the resume input (default = the run's original).
  cancelled: boolean | null;
  concurrency: number | null;
  // True only while the run's subprocess is actually alive (server-side liveness,
  // same source as the DELETE 409 guard) — not inferred from completed_at.
  running: boolean;
  // True while a judge-only re-judge is in flight on this run.
  // Separate from `running` (run stays "done"); lets the list show "judging" + keep
  // polling after a refresh, when in-memory liveId is lost.
  judging: boolean;
  // Waiting in the serial queue: submitted, no run directory yet, nothing executed.
  // queue_position is 1-based within the queue.
  queued?: boolean;
  queue_position?: number | null;
  queued_at?: string | null;
  queue_paused?: boolean;
  // Audit of the taskspace purge performed just before this run was released.
  preflight?: { ok?: boolean; total?: number; closed?: string[]; error?: string | null } | null;
  queue_error?: string | null;
  // Who launched the run: "webui" or "cli". Absent on runs written before the field.
  origin?: "webui" | "cli" | null;
  // "A" while the run occupies the queue's execution slot, "B" once Stage A finished
  // and only exporting/judging remains (slot already released). Null when not running.
  stage?: "A" | "B" | null;
  task_count_planned: number | null;
  done: number;
  fail: number;
  // Tasks stopped by an agent-reported CAPTCHA / anti-bot wall, excluded from `fail`
  // and never judged. Absent on runs whose backend predates the field.
  captcha?: number;
  has_summary: boolean;
  // Shared manual note from runs/<id>/note.md; Artifacts reads the same field.
  note: string;
}

export interface QueueItem {
  run_id: string;
  position: number;
  queued_at: string;
  benchmark: string | null;
  browser_tool: string | null;
  provider: string | null;
  model: string | null;
  task_count_planned: number | null;
  preflight: Record<string, any> | null;
  error: string | null;
}

export interface QueueState {
  paused: boolean;
  queue: QueueItem[];
  // Runs currently holding the Stage-A slot (ours and CLI-started alike).
  executing: string[];
}

export interface StartRunResult {
  run_id: string;
  // false → launched right away; true → waiting at `position` in the queue.
  queued: boolean;
  position: number;
}

export interface RunProgress {
  run_id: string;
  status: "running" | "done" | "error" | "stopped";
  total: number;
  done: number;
  fail: number;
  skip: number;
  active: number;
  // Tasks whose agent reported an unpassable human-verification wall. A terminal
  // outcome of its own: kept out of `fail` and out of the judge's denominator.
  captcha?: number;
  tasks: {
    task_id: string;
    status: string;
    slot: number;
    has_session: boolean;
    // Locate live-snapshot sessions from events for running
    // tasks, tasks.jsonl for finished ones.
    session_known: boolean;
    // wall elapsed: records' started/ended for finished tasks, start-event ts for
    // running ones; turns come from progress or final events
    // (final) — both nullable.
    duration_s: number | null;
    turns: number | null;
    // total attempts (tasks.jsonl attempt_count for finished, attempt event for
    // running); retries = attempts - 1. Nullable.
    attempts: number | null;
  }[];
  // Judge progress appears once Stage B begins, from the
  // judging_started_at marker on a live run (judged may still be 0, before the first
  // verdict file lands) or from on-disk judges/*.json; null when the run has no judge.
  // "running" while Stage B is in flight (run status still "running", every task resolved)
  // or while a judge-only re-judge runs on a completed run.
  // total = resolved tasks judge covers; judged = pass + fail + err; pending
  // (not-yet-judged) = total − judged, derived frontend-side.
  judge?: {
    status: "running" | "done";
    total: number;
    judged: number;
    pass: number;
    fail: number;
    err: number;
  } | null;
  // Authoritative judge-only subprocess liveness,
  // alive on this run" (= backend is_judging), SEPARATE from `judge` (the count block, which
  // is null until judges/*.json exist). On a never-judged run a re-judge runs with judge
  // still null — gate Stop + poll-keepalive on this, not on judge.status. true while live.
  judging?: boolean;
  // True while run_eval is exporting sessions after Stage A,
  // (rendering sessions_html/) — after completed_at, before auto-judge starts
  // (judging_started_at → judge block appears with judged=0 and this flips false). Run
  // status is still "running" and judge still null, so the hero pill reads "exporting"
  // instead of a bare "running" for that 100%-but-not-yet-judging window. false otherwise.
  exporting?: boolean;
  // True when run_eval recorded a mid-flight stop; gates the
  // resume button on the Progress view, robust to the "stopped" pill being lost after a
  // WebUI restart (when no handle exists, status falls back to done/error).
  cancelled?: boolean;
}

// Per-task judge snapshot for the cart's rubric picker. has_rubrics=false
// for binary judges (no rubric_results) → whole-task selection only (row checkbox).
export interface TaskRubric {
  rubric_id: string;
  requirement: string | null;
  verification: string | null;
  satisfied: boolean | null;
  confidence: number | null;
  reasoning: string | null;
}

export interface TaskJudge {
  task_id: string;
  verdict: boolean | null;
  score: number | null;
  judge_error: string | null;
  judge_model: string | null;
  judge_mode: string | null;
  has_rubrics: boolean;
  rubrics: TaskRubric[];
}

// Shared judge aggregate: pass + fail + err = judged; pending = total - judged.
export interface JudgeAggregate {
  status: "running" | "done";
  total: number;
  judged: number;
  pass: number;
  fail: number;
  err: number;
}

// Current judge-job targets and completion count come from judges/_job.json,
// capturing the job-specific dimension the full-run aggregate cannot
// express on a subset re-judge. Null unless a judge process is live with an unfinished
// manifest (liveness is the gate; a stale manifest never dangles).
export interface JudgeJob {
  total: number | null;
  done: number | null;
  started_at: string | null;
  done_ids?: string[];
  targets: { task_id: string; rubric_ids: string[] | null }[];
}

// Per-task judge row. duration_s and turns are null on
// pre-field runs (judge.json written before the fields existed) → rendered as "—".
// rubric_pass/rubric_total: rubric dual-state column (null for binary judges);
// judging_rubric: the in-flight rubric from the progress sidecar, only while judging.
export interface JudgeTask {
  task_id: string;
  task_status: string;
  // "captcha" = Stage A intercepted the task on an anti-bot wall, so no judge ever
  // runs on it; distinct from "pending", which means a verdict is still coming.
  judge_status: "pass" | "fail" | "err" | "pending" | "captcha";
  verdict: boolean | null;
  judge_error: string | null;
  duration_s: number | null;
  turns: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  judge_mode: string | null;
  judge_session_url: string | null;
  rubric_pass: number | null;
  rubric_total: number | null;
  judging_rubric: { rubric_id: string | null; done: number | null; total: number | null } | null;
}

// Judge dashboard payload combines aggregates, job progress, and per-task detail.
// Mirrors the judge slice of RunProgress but adds the per-task breakdown Progress no longer
// carries.
export interface JudgeProgress {
  run_id: string;
  status: "running" | "done" | "error" | "stopped";
  judge: JudgeAggregate | null;
  judging: boolean;
  job: JudgeJob | null;
  exporting: boolean;
  cancelled: boolean;
  total: number;
  // resolved (done+fail+skip) = the set judge covers; judge "pending" until Stage A done.
  resolved: number;
  tasks: JudgeTask[];
}

export interface PiModelInfo {
  provider: string;
  model: string;
  context: string;
  max_out: string;
  thinking: boolean;
  images: boolean;
}

export interface CodexReasoningEffortInfo {
  reasoning_effort: string;
  description: string;
}

export interface CodexServiceTierInfo {
  id: string;
  name: string;
  description: string;
}

export interface CodexModelInfo {
  id: string;
  model: string;
  display_name: string;
  description: string;
  is_default: boolean;
  default_reasoning_effort: string;
  supported_reasoning_efforts: CodexReasoningEffortInfo[];
  service_tiers: CodexServiceTierInfo[];
  default_service_tier: string | null;
}

export interface ArtifactFile {
  name: string;
  mtime: number;
  size: number;
}

export interface ArtifactGroup {
  run_id: string;
  derived_from: string | null;
  reports: ArtifactFile[];
  sessions_count: number;
  latest_mtime: number;
  // dataset (benchmark) for the Artifacts category grouping/filter; null on ad-hoc runs.
  benchmark: string | null;
  // Agent and judge models used by this run
  // (e.g. "openai-codex/gpt-5.4"). Null on pre-field / metadata-less runs.
  model: string | null;
  provider: "pi" | "codex" | null;
  model_provider: string | null;
  // agent provider, so the task model renders provider/model like the judge
  // (e.g. "openai-codex/gpt-5.5"). Null on pre-field runs.
  pi_provider: string | null;
  judge_model: string | null;
  judge_mode: string | null;
  // manual run note (runs/<id>/note.md), editable inline; "" when none.
  note: string;
}

// wiek-browser release management targets Wiek Browser's runtime index.js through the
// debug override symlink, independently of the CLI resolved from PATH.
export interface WiekRelease {
  tag: string;
  name: string;
  published_at: string | null;
  prerelease: boolean;
  latest: boolean; // GitHub make_latest marker.
  downloadable: boolean; // A matching wiek-browser-*.zip asset exists.
  asset: { name: string; size: number | null } | null;
  downloaded: boolean; // Present in the local cache.
  active: boolean; // The current symlink points to this release.
}

export interface WiekActiveState {
  active_tag: string | null;
  source: "managed" | "external" | "none";
  external_target: string | null;
  external_origin: string | null; // Recoverable development-build path.
  index_js_realpath: string | null;
  index_js_sha256: string | null;
}

export interface WiekCachedRelease {
  tag: string;
  active: boolean;
}

export interface WiekBrowserStatusPayload {
  active: WiekActiveState;
  cached_releases: WiekCachedRelease[];
}

export interface WiekReleasesPayload extends WiekBrowserStatusPayload {
  releases: WiekRelease[];
  error: string | null;
}

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// Rerun/resume refused because the active wiek-browser runtime is no longer the one the
// run was recorded against. The only refusal the console may answer: it explains the
// mixed runtime pool and re-sends with allow_runtime_mismatch once the user confirms.
export const RUNTIME_MISMATCH_CODE = "wiek_runtime_mismatch";

/** A failed request that named its reason, so callers can branch on it instead of on prose. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isRuntimeMismatch = (e: unknown): boolean =>
  e instanceof ApiError && e.code === RUNTIME_MISMATCH_CODE;

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    let code: string | null = null;
    try {
      const d = JSON.parse(text)?.detail; // FastAPI HTTPException detail payload.
      if (typeof d === "string") detail = d;
      // Coded refusals carry {code, message} instead of a bare string.
      else if (d && typeof d === "object" && typeof d.message === "string") {
        detail = d.message;
        code = typeof d.code === "string" ? d.code : null;
      }
    } catch {
      // Display a non-JSON response body unchanged.
    }
    throw new ApiError(detail || `${url} → ${r.status}`, code);
  }
  return r.json();
}

async function jput<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || `${url} → ${r.status}`);
  return r.json();
}

async function jdel<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(detail || `${url} → ${r.status}`);
  }
  return r.json();
}

export const api = {
  datasets: () => jget<DatasetInfo[]>("/api/datasets"),
  config: () => jget<Record<string, any>>("/api/config"),
  skills: () => jget<{ skills: string[]; diagnostics: string[] }>("/api/skills"),
  piModels: () => jget<{ models: PiModelInfo[]; error: string | null }>("/api/pi/models"),
  codexModels: (codexHome?: string) =>
    jget<{ models: CodexModelInfo[]; error: string | null }>(
      `/api/codex/models${codexHome ? `?codex_home=${encodeURIComponent(codexHome)}` : ""}`,
    ),
  artifacts: () => jget<ArtifactGroup[]>("/api/artifacts"),
  runs: () => jget<RunInfo[]>("/api/runs"),
  progress: (id: string) => jget<RunProgress>(`/api/runs/${encodeURIComponent(id)}/progress`),
  // Judge dashboard aggregate and per-task detail.
  judgeProgress: (id: string) =>
    jget<JudgeProgress>(`/api/runs/${encodeURIComponent(id)}/judge-progress`),
  summary: (id: string) => jget<Record<string, any>>(`/api/runs/${encodeURIComponent(id)}/summary`),
  runConfig: (id: string) =>
    jget<Record<string, any>>(`/api/runs/${encodeURIComponent(id)}/config`),
  systemPrompt: (id: string) =>
    jget<Record<string, any>>(`/api/runs/${encodeURIComponent(id)}/system-prompt`),
  startRun: (overrides: Record<string, any>) =>
    jpost<StartRunResult>("/api/runs", { overrides }),
  queue: () => jget<QueueState>("/api/queue"),
  queuePause: (paused: boolean) => jpost<{ paused: boolean }>("/api/queue/pause", { paused }),
  // Launch a queued run ahead of its turn (the taskspace purge still runs).
  queueStartNow: (id: string) =>
    jpost<{ run_id: string }>(`/api/queue/${encodeURIComponent(id)}/start-now`, {}),
  queueMove: (id: string, body: { top?: boolean; to?: number }) =>
    jpost<{ position: number }>(`/api/queue/${encodeURIComponent(id)}/move`, body),
  stopRun: (id: string) => jpost<{ stopped: boolean }>(`/api/runs/${encodeURIComponent(id)}/stop`, {}),
  // Resume a stopped or cancelled run in place, preserving the
  // run_id. Optional concurrency override (omit → keep the run's original).
  resume: (id: string, body: { concurrency?: number; allow_runtime_mismatch?: boolean }) =>
    jpost<{ run_id: string }>(`/api/runs/${encodeURIComponent(id)}/resume`, body),
  // Force-rerun errors or selected tasks. Overwrite returns the
  // same run_id; new_run=true → derived run id (optional new agent model + concurrency).
  rerun: (
    id: string,
    body: {
      task_ids?: string[];
      errors?: boolean;
      concurrency?: number;
      model?: string;
      new_run?: boolean;
      allow_runtime_mismatch?: boolean;
    },
  ) => jpost<{ run_id: string }>(`/api/runs/${encodeURIComponent(id)}/rerun`, body),
  // Re-run only the judge without re-running Stage A.
  // errors=true → judge-errored tasks; targets → the cart submit (multi task × rubric
  // subset; rubric_ids absent = whole task). Overwrite → same run_id; new_run → derived.
  rejudge: (
    id: string,
    body: {
      targets?: { task_id: string; rubric_ids?: string[] }[];
      errors?: boolean;
      concurrency?: number;
      model?: string;
      judge_mode?: string;
      new_run?: boolean;
    },
  ) => jpost<{ run_id: string }>(`/api/runs/${encodeURIComponent(id)}/rejudge`, body),
  // Per-task verdict and rubric breakdown for the rubric picker.
  taskJudge: (id: string, taskId: string) =>
    jget<TaskJudge>(
      `/api/runs/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/judge`,
    ),
  sessionSnapshot: (id: string, taskId: string) =>
    jpost<{ url: string }>(
      `/api/runs/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/session-snapshot`,
      {},
    ),
  deleteRun: (id: string) => jdel<{ deleted: boolean }>(`/api/runs/${encodeURIComponent(id)}`),
  // Manual run note in runs/<id>/note.md; a blank PUT clears it.
  getNote: (id: string) => jget<{ note: string }>(`/api/runs/${encodeURIComponent(id)}/note`),
  putNote: (id: string, note: string) =>
    jput<{ note: string }>(`/api/runs/${encodeURIComponent(id)}/note`, { note }),
  exportSessions: (runs: string[]) =>
    jpost<{ path: string }>("/api/export/sessions", { runs }),
  exportSingle: (runs: string[], options: SingleReportOptions) =>
    jpost<{ path: string }>("/api/export/single", { runs, options }),
  // Build report HTML in place so artifact links open without a zip.
  buildReport: (runs: string[], options: SingleReportOptions) =>
    jpost<{ path: string }>("/api/report/single", { runs, options }),
  wiekStatus: () => jget<WiekBrowserStatusPayload>("/api/wiek-browser/status"),
  wiekReleases: () => jget<WiekReleasesPayload>("/api/wiek-browser/releases"),
  wiekActivate: (tag: string) => jpost<WiekActiveState>("/api/wiek-browser/activate", { tag }),
  wiekRestore: () => jpost<WiekActiveState>("/api/wiek-browser/restore-external", {}),
};
