import { useEffect, useMemo, useState } from "react";
import { App as AntdApp, AutoComplete, Button, Form, Input, InputNumber, Select, Spin, Switch, Tag } from "antd";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import {
  api,
  CodexModelInfo,
  DatasetInfo,
  WiekBrowserStatusPayload,
  WiekRelease,
  WiekReleasesPayload,
  PiModelInfo,
} from "../api";
import SegField from "./SegField";

type RunMode = "dataset" | "adhoc";
type AdhocInputMode = "tasks" | "json";

type AdhocValidationError =
  | { code: "parse"; detail: string }
  | { code: "array" }
  | { code: "taskObject"; index: number }
  | { code: "taskIdRequired"; index: number }
  | { code: "taskIdPath"; taskId: string }
  | { code: "taskIdDuplicate"; taskId: string }
  | { code: "confirmedTaskRequired"; taskId: string }
  | { code: "rubricsObject"; taskId: string }
  | { code: "rubricInvalid"; taskId: string; rubricId: string }
  | { code: "requirementRequired"; rubricId: string }
  | { code: "verificationRequired"; rubricId: string }
  | { code: "mixedRubrics" };

interface AdhocJsonAnalysis {
  tasks: Record<string, any>[] | null;
  judgeCapable: boolean;
  error: AdhocValidationError | null;
}

function analyseAdhocJson(text: string | undefined): AdhocJsonAnalysis {
  if (!text?.trim()) return { tasks: null, judgeCapable: false, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { tasks: null, judgeCapable: false, error: { code: "parse", detail: String(error) } };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { tasks: null, judgeCapable: false, error: { code: "array" } };
  }

  const ids = new Set<string>();
  const rubricFlags: boolean[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { tasks: null, judgeCapable: false, error: { code: "taskObject", index } };
    }
    const task = entry as Record<string, any>;
    const taskId = typeof task.task_id === "string" ? task.task_id.trim() : "";
    if (!taskId) {
      return { tasks: null, judgeCapable: false, error: { code: "taskIdRequired", index } };
    }
    if (taskId === "." || taskId === ".." || /[\\/]/.test(taskId) || /[\u0000-\u001f\u007f]/.test(taskId)) {
      return { tasks: null, judgeCapable: false, error: { code: "taskIdPath", taskId } };
    }
    if (ids.has(taskId)) {
      return { tasks: null, judgeCapable: false, error: { code: "taskIdDuplicate", taskId } };
    }
    ids.add(taskId);
    if (typeof task.confirmed_task !== "string" || !task.confirmed_task.trim()) {
      return { tasks: null, judgeCapable: false, error: { code: "confirmedTaskRequired", taskId } };
    }

    const rubrics = task.rubrics;
    if (rubrics != null && (typeof rubrics !== "object" || Array.isArray(rubrics))) {
      return { tasks: null, judgeCapable: false, error: { code: "rubricsObject", taskId } };
    }
    const rubricEntries = Object.entries((rubrics ?? {}) as Record<string, any>);
    rubricFlags.push(rubricEntries.length > 0);
    for (const [rubricId, spec] of rubricEntries) {
      if (!rubricId.trim() || !spec || typeof spec !== "object" || Array.isArray(spec)) {
        return {
          tasks: null,
          judgeCapable: false,
          error: { code: "rubricInvalid", taskId, rubricId: rubricId || "<empty>" },
        };
      }
      if (typeof spec.requirement !== "string" || !spec.requirement.trim()) {
        return { tasks: null, judgeCapable: false, error: { code: "requirementRequired", rubricId } };
      }
      if (typeof spec.verification !== "string" || !spec.verification.trim()) {
        return { tasks: null, judgeCapable: false, error: { code: "verificationRequired", rubricId } };
      }
    }
  }

  const anyRubrics = rubricFlags.some(Boolean);
  const allRubrics = rubricFlags.every(Boolean);
  if (anyRubrics && !allRubrics) {
    return {
      tasks: null,
      judgeCapable: false,
      error: { code: "mixedRubrics" },
    };
  }
  return {
    tasks: parsed as Record<string, any>[],
    judgeCapable: allRubrics,
    error: null,
  };
}

function adhocErrorText(t: TFunction, error: AdhocValidationError): string {
  switch (error.code) {
    case "parse":
      return t("newRun.validation.parse", { detail: error.detail });
    case "array":
      return t("newRun.validation.array");
    case "taskObject":
      return t("newRun.validation.taskObject", { index: error.index });
    case "taskIdRequired":
      return t("newRun.validation.taskIdRequired", { index: error.index });
    case "taskIdPath":
      return t("newRun.validation.taskIdPath", { taskId: error.taskId });
    case "taskIdDuplicate":
      return t("newRun.validation.taskIdDuplicate", { taskId: error.taskId });
    case "confirmedTaskRequired":
      return t("newRun.validation.confirmedTaskRequired", { taskId: error.taskId });
    case "rubricsObject":
      return t("newRun.validation.rubricsObject", { taskId: error.taskId });
    case "rubricInvalid":
      return t("newRun.validation.rubricInvalid", {
        taskId: error.taskId,
        rubricId: error.rubricId,
      });
    case "requirementRequired":
      return t("newRun.validation.requirementRequired", { rubricId: error.rubricId });
    case "verificationRequired":
      return t("newRun.validation.verificationRequired", { rubricId: error.rubricId });
    case "mixedRubrics":
      return t("newRun.validation.mixedRubrics");
  }
}

function isTextTaskProjection(tasks: Record<string, any>[]): boolean {
  return tasks.every((task, index) => {
    const expectedId = tasks.length === 1 ? "adhoc" : `adhoc-${index + 1}`;
    const keys = Object.keys(task);
    const rubrics = task.rubrics ?? {};
    return (
      task.task_id === expectedId &&
      typeof task.confirmed_task === "string" &&
      keys.every((key) => ["task_id", "confirmed_task", "rubrics"].includes(key)) &&
      rubrics &&
      typeof rubrics === "object" &&
      !Array.isArray(rubrics) &&
      Object.keys(rubrics).length === 0
    );
  });
}

function adhocInputModeForConfig(cfg: Record<string, any>): AdhocInputMode {
  const tasks = cfg.adhoc?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 && !isTextTaskProjection(tasks)
    ? "json"
    : "tasks";
}

// Filter AutoComplete only while the user is typing so a prefilled value does not
// hide the full candidate list. Form.Item injects value and onChange.
function AcField({
  options,
  placeholder,
  value,
  onChange,
}: {
  options: { value: string; label?: string }[];
  placeholder?: string;
  value?: string;
  onChange?: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = search
    ? options.filter((o) => o.value.toLowerCase().includes(search.toLowerCase()))
    : options;
  return (
    <AutoComplete
      className="mono w-full"
      value={value}
      onChange={onChange}
      options={shown}
      placeholder={placeholder}
      onSearch={setSearch}
      onDropdownVisibleChange={(open) => {
        if (!open) setSearch("");
      }}
    />
  );
}

function WiekReleaseRow({
  tag,
  latest,
  active,
  cached,
  downloadable,
  assetName,
  busy,
  onActivate,
}: {
  tag: string;
  latest: boolean;
  active: boolean;
  cached: boolean;
  downloadable: boolean;
  assetName?: string;
  busy: string | null;
  onActivate: (tag: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      className={`wiek-release-row${active ? " active" : ""}`}
      type="button"
      disabled={!downloadable || busy !== null}
      onClick={() => onActivate(tag)}
      title={downloadable ? assetName || t("newRun.release.switchVersion") : t("newRun.release.noAsset")}
      aria-current={active ? "true" : undefined}
    >
      <span className="wiek-release-tag">{tag}</span>
      {latest && <Tag color="blue">{t("newRun.release.latest")}</Tag>}
      {active && <Tag color="green">{t("newRun.release.active")}</Tag>}
      {cached && <Tag>{t("newRun.release.cached")}</Tag>}
      {!downloadable && <Tag>{t("newRun.release.assetMissing")}</Tag>}
      {busy === tag && <Spin size="small" />}
    </button>
  );
}

// Mount release management only for wiek-browser. It targets Wiek Browser's runtime
// index.js through a debug override symlink, independently of the CLI.
function WiekBrowserVersion() {
  const { message } = AntdApp.useApp();
  const { t } = useTranslation();
  const [status, setStatus] = useState<WiekBrowserStatusPayload | null>(null);
  const [catalog, setCatalog] = useState<WiekReleasesPayload | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // Active tag operation or "__restore__".

  const applyStatus = (next: WiekBrowserStatusPayload) => {
    const cachedTags = new Set(next.cached_releases.map((release) => release.tag));
    setStatus(next);
    setCatalog((current) =>
      current
        ? {
            ...current,
            active: next.active,
            cached_releases: next.cached_releases,
            releases: current.releases.map((release) => ({
              ...release,
              active:
                next.active.source === "managed" && next.active.active_tag === release.tag,
              downloaded: cachedTags.has(release.tag) || release.downloaded,
            })),
          }
        : current,
    );
  };

  const loadStatus = async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      applyStatus(await api.wiekStatus());
    } catch (error) {
      setStatusError(String(error));
    } finally {
      setStatusLoading(false);
    }
  };

  const loadCatalog = async () => {
    setCatalogLoading(true);
    try {
      const next = await api.wiekReleases();
      setCatalog(next);
      setStatus({ active: next.active, cached_releases: next.cached_releases });
      setStatusError(null);
    } catch (error) {
      message.error(String(error));
    } finally {
      setCatalogLoading(false);
    }
  };

  // Initial load reads local state only; refresh explicitly fetches the remote catalog.
  useEffect(() => {
    void loadStatus();
  }, []);

  const activate = async (tag: string) => {
    setBusy(tag);
    try {
      const nextActive = await api.wiekActivate(tag);
      setCatalog((current) =>
        current
          ? {
              ...current,
              active: nextActive,
              releases: current.releases.map((release) => ({
                ...release,
                active: release.tag === tag,
                downloaded: release.downloaded || release.tag === tag,
              })),
            }
          : current,
      );
      message.success(t("newRun.release.switched", { tag }));
      await loadStatus();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("__restore__");
    try {
      await api.wiekRestore();
      message.success(t("newRun.release.restored"));
      await loadStatus();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const active = status?.active;
  const cachedReleases = status?.cached_releases ?? [];
  const catalogByTag = new Map<string, WiekRelease>(
    (catalog?.releases ?? []).map((release) => [release.tag, release]),
  );
  const availableReleases = (catalog?.releases ?? []).filter((release) => !release.downloaded);

  return (
    <div className="field span2">
      <label>
        {t("newRun.release.field")} <span className="opt">{t("newRun.release.hint")}</span>
      </label>

      <div className="wiek-version-status desc">
        {statusLoading && !active ? (
          <span className="wiek-version-loading">
            <Spin size="small" /> {t("newRun.release.reading")}
          </span>
        ) : statusError && !active ? (
          <span>{t("newRun.release.currentReadFailed")}</span>
        ) : !active || active.source === "none" ? (
          <span>{t("newRun.release.currentNoSymlink")}</span>
        ) : active.source === "managed" ? (
          <span>
            {t("newRun.release.current")}
            <b className="mono">{active.active_tag}</b>
            {t("newRun.release.managedSuffix")}
          </span>
        ) : (
          <span>
            {t("newRun.release.current")}
            {t("newRun.release.externalPrefix")}
            <code className="mono">{active.external_target}</code>
            {t("newRun.release.externalSuffix")}
          </span>
        )}
        {/* Expose development-build restoration whenever external_origin exists. */}
        {active && active.source !== "external" && active.external_origin && (
          <Button
            size="small"
            onClick={restore}
            loading={busy === "__restore__"}
            disabled={busy !== null}
            title={t("newRun.release.restoreTitle", { path: active.external_origin })}
          >
            {t("newRun.release.restore")}
          </Button>
        )}
        <Button
          size="small"
          type="text"
          onClick={loadCatalog}
          loading={catalogLoading}
          disabled={busy !== null}
        >
          {t("common.actions.refresh")}
        </Button>
      </div>

      {statusError && (
        <div className="desc wiek-version-error">
          {t("newRun.release.statusFailed", { detail: statusError })}
        </div>
      )}

      <details className="wiek-cache-panel">
        <summary>
          <span>{t("newRun.release.cachedVersions")}</span>
          <span className="wiek-cache-limit">{t("newRun.release.cacheLimit")}</span>
        </summary>
        <div className="wiek-version-list">
          {cachedReleases.map((release) => {
            const metadata = catalogByTag.get(release.tag);
            return (
              <WiekReleaseRow
                key={release.tag}
                tag={release.tag}
                latest={metadata?.latest ?? false}
                active={release.active}
                cached
                downloadable
                assetName={metadata?.asset?.name}
                busy={busy}
                onActivate={activate}
              />
            );
          })}
          {!statusLoading && !statusError && cachedReleases.length === 0 && (
            <div className="desc wiek-version-empty">{t("newRun.release.noCachedVersions")}</div>
          )}
          {!statusLoading && statusError && !status && (
            <div className="desc wiek-version-empty wiek-version-error">
              {t("newRun.release.cacheStatusFailed")}
            </div>
          )}
        </div>
      </details>

      {catalog?.error && (
        <div className="desc wiek-version-error">
          {t("newRun.release.catalogUnavailable", { detail: catalog.error })}
        </div>
      )}

      <div className="wiek-version-list">
        {availableReleases.map((release) => (
          <WiekReleaseRow
            key={release.tag}
            tag={release.tag}
            latest={release.latest}
            active={release.active}
            cached={false}
            downloadable={release.downloadable}
            assetName={release.asset?.name}
            busy={busy}
            onActivate={activate}
          />
        ))}
        {!catalog && !catalogLoading && (
          <div className="desc wiek-version-empty">{t("newRun.release.refreshForReleases")}</div>
        )}
        {catalog && !catalogLoading && availableReleases.length === 0 && !catalog.error && (
          <div className="desc wiek-version-empty">{t("newRun.release.allCached")}</div>
        )}
      </div>
      <div className="desc">{t("newRun.release.description")}</div>
    </div>
  );
}

interface Props {
  // `queued` distinguishes "launched now" from "waiting in the queue": a queued run has
  // no run directory yet, so the caller must not route to its progress view.
  onStarted: (runId: string, queued: boolean) => void;
  // When set (reuse-config flow), these nested-config overrides are layered over the
  // current defaults to prefill the form. An ``adhoc`` node switches
  // the form into ad-hoc mode and restores its complete task snapshot.
  prefill?: Record<string, any> | null;
}

// Maps a nested config dict (defaults from /api/config or a run snapshot from
// /api/runs/{id}/config) onto the flat antd form field names.
function cfgToFields(cfg: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { adhoc_prompts: [""], adhoc_json: "" };
  const set = (k: string, v: any) => {
    if (v !== undefined && v !== null) out[k] = v;
  };
  set("benchmark", cfg.run?.benchmark);
  set("agent_provider", cfg.run?.provider ?? "pi");
  set("browser_tool", cfg.run?.browser_tool);
  set("browser_tool_mode", cfg.run?.browser_tool_mode);
  set("concurrency", cfg.run?.concurrency);
  set("iterations", cfg.run?.iterations);
  set("retry_count", cfg.run?.retry_count);
  set("auto_judge", cfg.run?.auto_judge);
  set("auto_export_sessions", cfg.run?.auto_export_sessions);
  if (cfg.sampling?.task_ids) out["task_ids"] = cfg.sampling.task_ids || [];
  const adhocTasks = cfg.adhoc?.tasks;
  if (Array.isArray(adhocTasks) && adhocTasks.length > 0) {
    if (isTextTaskProjection(adhocTasks)) {
      out.adhoc_prompts = adhocTasks.map((task: Record<string, any>) => task.confirmed_task);
    } else {
      out.adhoc_json = JSON.stringify(adhocTasks, null, 2);
    }
  } else if (typeof cfg.adhoc?.task === "string" && cfg.adhoc.task.trim()) {
    out.adhoc_prompts = [cfg.adhoc.task];
  }
  // Preserve both limit defaults while limit_mode selects which value is submitted.
  set("limit_mode", cfg.limits?.mode ?? "time");
  set("task_timeout_seconds", cfg.limits?.task_timeout_seconds);
  set("max_turns", cfg.limits?.max_turns);
  set("pi_provider", cfg.providers?.pi?.provider);
  set("pi_model", cfg.providers?.pi?.model);
  set("thinking_level", cfg.providers?.pi?.thinking_level);
  set("tool_profile", cfg.providers?.pi?.tool_profile);
  set("codex_model", cfg.providers?.codex?.model);
  set("codex_reasoning_effort", cfg.providers?.codex?.reasoning_effort);
  set("codex_home", cfg.providers?.codex?.codex_home);
  set("codex_service_tier", cfg.providers?.codex?.service_tier);
  set("judge_mode", cfg.judge?.mode);
  set("judge_model", cfg.judge?.model);
  set("judge_concurrency", cfg.judge?.concurrency);
  set("max_screenshots", cfg.judge?.max_screenshots);
  // Skill selection is nested under the run's browser tool.
  const bt = cfg.run?.browser_tool;
  if (bt) set("skill_name", cfg.browser_tools?.[bt]?.skill_name);
  return out;
}

// Complex multi-field config form → antd Form (per project convention), reskinned to
// the Pine-ink visual language. Data flow is unchanged.
export default function ConfigForm({ onStarted, prefill }: Props) {
  const { message } = AntdApp.useApp();
  const { t } = useTranslation();
  const adhocInputLabels: Record<string, string> = {
    tasks: t("newRun.adhoc.inputModes.tasks"),
    json: t("newRun.adhoc.inputModes.json"),
  };
  const guardModeLabels: Record<string, string> = {
    strict: t("newRun.run.guardModes.strict"),
    loose: t("newRun.run.guardModes.loose"),
    off: t("newRun.run.guardModes.off"),
  };
  const agentProviderLabels: Record<string, string> = {
    pi: t("newRun.provider.agentProviders.pi"),
    codex: t("newRun.provider.agentProviders.codex"),
  };
  const thinkingLevelLabels: Record<string, string> = {
    off: t("newRun.provider.thinkingLevels.off"),
    minimal: t("newRun.provider.thinkingLevels.minimal"),
    low: t("newRun.provider.thinkingLevels.low"),
    medium: t("newRun.provider.thinkingLevels.medium"),
    high: t("newRun.provider.thinkingLevels.high"),
    xhigh: t("newRun.provider.thinkingLevels.xhigh"),
    max: t("newRun.provider.thinkingLevels.max"),
  };
  const toolProfileLabels: Record<string, string> = {
    full: t("newRun.provider.toolProfiles.full"),
    readonly: t("newRun.provider.toolProfiles.readonly"),
  };
  const limitModeLabels: Record<string, string> = {
    time: t("newRun.limits.limitModes.time"),
    steps: t("newRun.limits.limitModes.steps"),
  };
  const judgeModeLabels: Record<string, string> = {
    single: t("newRun.limits.judgeModes.single"),
    agent: t("newRun.limits.judgeModes.agent"),
  };
  const [form] = Form.useForm();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [starting, setStarting] = useState(false);
  // Queue occupancy, so the launch button can say up front whether this submission
  // starts now or lines up behind something. Polled: the slot can free while the
  // form sits open.
  const [queueInfo, setQueueInfo] = useState<{ waiting: number; busy: boolean } | null>(null);
  // Dataset versus ad-hoc mode.
  const [mode, setMode] = useState<RunMode>("dataset");
  const [adhocInputMode, setAdhocInputMode] = useState<AdhocInputMode>("tasks");
  // Skill candidates include each browser tool's default skill_name,
  // so switching tool resets the Skill field to that tool's default.
  const [skills, setSkills] = useState<string[]>([]);
  const [btDefaults, setBtDefaults] = useState<Record<string, string>>({});
  // Options come from config.yaml browser_tools, so integrating another browser
  // tool needs no frontend change.
  const [browserTools, setBrowserTools] = useState<string[]>([]);
  // Use pi --list-models candidates, falling back to free text when empty.
  const [piModels, setPiModels] = useState<PiModelInfo[]>([]);
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>([]);
  const [codexModelsError, setCodexModelsError] = useState<string | null>(null);

  // Keep the launch button honest about what pressing it will do.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .queue()
        .then((s) => {
          if (alive) setQueueInfo({ waiting: s.queue.length, busy: s.executing.length > 0 });
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    api.datasets().then(setDatasets).catch((e) => message.error(String(e)));
    api.skills().then((r) => setSkills(r.skills)).catch((e) => message.error(String(e)));
    api
      .piModels()
      .then((r) => {
        setPiModels(r.models);
        if (r.error) message.warning(t("newRun.feedback.piModelsUnavailable", { detail: r.error }));
      })
      .catch(() => undefined);
    api.config().then((cfg) => {
      const bts = (cfg.browser_tools || {}) as Record<string, { skill_name?: string }>;
      setBrowserTools(Object.keys(bts));
      setBtDefaults(
        Object.fromEntries(
          Object.entries(bts).map(([t, c]) => [t, c?.skill_name]).filter(([, s]) => s),
        ) as Record<string, string>,
      );
      // defaults first, then layer the reuse-config snapshot on top
      form.setFieldsValue(cfgToFields(cfg));
      if (prefill) {
        form.setFieldsValue(cfgToFields(prefill));
        // New and legacy snapshots both auto-switch and restore the original tasks.
        if (prefill.adhoc?.tasks || prefill.adhoc?.task) {
          const inputMode = adhocInputModeForConfig(prefill);
          setAdhocInputMode(inputMode);
          setMode("adhoc");
          const fields = cfgToFields(prefill);
          const capability =
            inputMode === "json" && analyseAdhocJson(fields.adhoc_json).judgeCapable;
          form.setFieldValue(
            "auto_judge",
            capability ? Boolean(prefill.run?.auto_judge) : false,
          );
        } else {
          setMode("dataset");
        }
      }
    });
  }, [form, prefill]);

  const submit = async () => {
    let v: Record<string, any>;
    try {
      v = await form.validateFields();
    } catch {
      // noStyle Form.Items don't render inline errors, so surface a toast instead.
      message.error(t("newRun.feedback.requiredFields"));
      return;
    }
    const runOverride: Record<string, any> = {
      provider: v.agent_provider,
      browser_tool: v.browser_tool,
      browser_tool_mode: v.browser_tool_mode,
      concurrency: v.concurrency,
      iterations: v.iterations,
      retry_count: v.retry_count,
      auto_judge: v.auto_judge,
      auto_export_sessions: v.auto_export_sessions,
    };
    const overrides: Record<string, any> = {
      run: runOverride,
      // Submit only the limit selected by mode and leave the other at its backend default.
      limits:
        v.limit_mode === "steps"
          ? { mode: "steps", max_turns: v.max_turns }
          : { mode: "time", task_timeout_seconds: v.task_timeout_seconds },
      providers:
        v.agent_provider === "codex"
          ? {
              codex: {
                codex_home: v.codex_home,
                model: v.codex_model,
                reasoning_effort: v.codex_reasoning_effort,
                service_tier: v.codex_service_tier || null,
              },
            }
          : {
              pi: {
                provider: v.pi_provider,
                model: v.pi_model,
                thinking_level: v.thinking_level,
                tool_profile: v.tool_profile,
              },
            },
      judge: {
        mode: v.judge_mode,
        model: v.judge_model,
        concurrency: v.judge_concurrency,
        max_screenshots: v.max_screenshots,
      },
    };
    // Key the skill override by the selected browser tool.
    if (v.skill_name && v.browser_tool) {
      overrides.browser_tools = { [v.browser_tool]: { skill_name: v.skill_name } };
    }
    if (mode === "adhoc") {
      let tasks: Record<string, any>[];
      if (adhocInputMode === "json") {
        const analysis = analyseAdhocJson(v.adhoc_json);
        if (!analysis.tasks || analysis.error) {
          message.error(
            analysis.error
              ? adhocErrorText(t, analysis.error)
              : t("newRun.feedback.adhocJsonRequired"),
          );
          return;
        }
        tasks = analysis.tasks;
        runOverride.auto_judge = analysis.judgeCapable && Boolean(v.auto_judge);
      } else {
        const prompts = ((v.adhoc_prompts as string[] | undefined) || []).map((task) =>
          task.trim(),
        );
        if (!prompts.length || prompts.some((task) => !task)) {
          message.error(t("newRun.feedback.adhocTasksRequired"));
          return;
        }
        tasks = prompts.map((confirmedTask, index) => ({
          task_id: prompts.length === 1 ? "adhoc" : `adhoc-${index + 1}`,
          confirmed_task: confirmedTask,
          rubrics: {},
        }));
        runOverride.auto_judge = false;
      }
      // Both projections share one backend boundary and the existing endpoint.
      overrides.adhoc = { tasks };
    } else {
      runOverride.benchmark = v.benchmark;
      const taskIds = ((v.task_ids as string[] | undefined) || [])
        .map((s) => s.trim())
        .filter(Boolean);
      overrides.sampling = { task_ids: taskIds.length ? taskIds : null };
    }
    setStarting(true);
    try {
      const { run_id, queued, position } = await api.startRun(overrides);
      message.success(
        queued
          ? t("newRun.feedback.queued", { runId: run_id, position })
          : t("newRun.feedback.started", { runId: run_id }),
      );
      onStarted(run_id, queued);
    } catch (e) {
      message.error(String(e));
    } finally {
      setStarting(false);
    }
  };

  // Something executing, or anyone already waiting, means this submission queues.
  const willQueue = Boolean(queueInfo && (queueInfo.busy || queueInfo.waiting > 0));
  const queuePosition = (queueInfo?.waiting ?? 0) + 1;

  // Live summary rail values.
  const wBenchmark = Form.useWatch("benchmark", form);
  const wAgentProvider = Form.useWatch("agent_provider", form) || "pi";
  const wPiProvider = Form.useWatch("pi_provider", form);
  const wCodexModel = Form.useWatch("codex_model", form);
  const wCodexHome = Form.useWatch("codex_home", form);
  useEffect(() => {
    if (wAgentProvider !== "codex" || !wCodexHome) return;
    let cancelled = false;
    setCodexModels([]);
    setCodexModelsError(null);
    const timer = window.setTimeout(() => {
      api
        .codexModels(wCodexHome)
        .then((result) => {
          if (cancelled) return;
          setCodexModels(result.models);
          setCodexModelsError(result.error);
        })
        .catch((error) => {
          if (cancelled) return;
          setCodexModels([]);
          setCodexModelsError(String(error));
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wAgentProvider, wCodexHome]);
  // Selected dataset is derived from the watched benchmark field (single source), so
  // the level/category meta-row renders immediately on the default-filled benchmark —
  // not only after the user manually reselects one.
  const selected = useMemo(
    () => datasets.find((d) => d.name === wBenchmark) ?? null,
    [datasets, wBenchmark],
  );
  // Build task selector candidates as `task_id · category`.
  const taskOptions = useMemo(
    () => (selected?.tasks ?? []).map((t) => ({ value: t.task_id, label: `${t.task_id} · ${t.category}` })),
    [selected],
  );

  // Derive dropdown candidates from pi --list-models.
  const providerOptions = useMemo(
    () => Array.from(new Set(piModels.map((m) => m.provider))).map((p) => ({ value: p })),
    [piModels],
  );
  const modelOptions = useMemo(
    () =>
      piModels
        .filter((m) => !wPiProvider || m.provider === wPiProvider)
        .map((m) => ({ value: m.model, label: `${m.model}  ·  ${m.context} ctx` })),
    [piModels, wPiProvider],
  );
  const selectedCodexModel = useMemo(
    () => codexModels.find((model) => model.model === wCodexModel) ?? null,
    [codexModels, wCodexModel],
  );
  const codexModelOptions = useMemo(
    () =>
      codexModels.map((model) => ({
        value: model.model,
        label: `${model.display_name}  ·  ${model.model}${
          model.is_default ? `  ·  ${t("newRun.provider.modelDefault")}` : ""
        }`,
      })),
    [codexModels, t],
  );
  const codexServiceTierOptions = useMemo(
    () => [
      { value: "", label: t("newRun.provider.standardRouting") },
      ...(selectedCodexModel?.service_tiers ?? []).map((tier) => ({
        value: tier.id,
        label: `${tier.name}  ·  ${tier.description}`,
      })),
    ],
    [selectedCodexModel, t],
  );
  const codexReasoningOptions = useMemo(
    () =>
      (selectedCodexModel?.supported_reasoning_efforts ?? []).map((effort) => ({
        value: effort.reasoning_effort,
        label: `${effort.reasoning_effort}  ·  ${effort.description}`,
      })),
    [selectedCodexModel],
  );
  useEffect(() => {
    if (!selectedCodexModel) return;

    const reasoningValues = selectedCodexModel.supported_reasoning_efforts.map(
      (effort) => effort.reasoning_effort,
    );
    const currentReasoning = form.getFieldValue("codex_reasoning_effort") as string | undefined;
    if (!currentReasoning || !reasoningValues.includes(currentReasoning)) {
      form.setFieldValue("codex_reasoning_effort", selectedCodexModel.default_reasoning_effort);
    }

    const tierValues = ["", ...selectedCodexModel.service_tiers.map((tier) => tier.id)];
    const currentTier = form.getFieldValue("codex_service_tier") as string | undefined;
    if (!currentTier || !tierValues.includes(currentTier)) {
      const defaultTier = selectedCodexModel.default_service_tier;
      form.setFieldValue(
        "codex_service_tier",
        defaultTier && tierValues.includes(defaultTier) ? defaultTier : "",
      );
    }
  }, [form, selectedCodexModel]);
  // Judge must support image input (single-turn multimodal) → images=yes only.
  const judgeOptions = useMemo(
    () =>
      piModels
        .filter((m) => m.images)
        .map((m) => ({ value: `${m.provider}/${m.model}` })),
    [piModels],
  );
  const wTaskIds = Form.useWatch("task_ids", form) as string[] | undefined;
  const wTool = Form.useWatch("browser_tool", form);
  const wSkill = Form.useWatch("skill_name", form);
  const wGuard = Form.useWatch("browser_tool_mode", form);
  const wConc = Form.useWatch("concurrency", form);
  const wPiModel = Form.useWatch("pi_model", form);
  const wPiThinking = Form.useWatch("thinking_level", form);
  const wCodexThinking = Form.useWatch("codex_reasoning_effort", form);
  const wModel = wAgentProvider === "codex" ? wCodexModel : wPiModel;
  const wThinking = wAgentProvider === "codex" ? wCodexThinking : wPiThinking;
  const wJudge = Form.useWatch("auto_judge", form);
  const wLimitMode = Form.useWatch("limit_mode", form);
  const wAdhocJson = Form.useWatch("adhoc_json", form) as string | undefined;
  const wAdhocPrompts = Form.useWatch("adhoc_prompts", form) as string[] | undefined;
  const adhocJsonAnalysis = useMemo(() => analyseAdhocJson(wAdhocJson), [wAdhocJson]);
  const adhocJsonError = adhocJsonAnalysis.error
    ? adhocErrorText(t, adhocJsonAnalysis.error)
    : null;
  const adhocJudgeCapable =
    mode === "adhoc" && adhocInputMode === "json" && adhocJsonAnalysis.judgeCapable;
  const adhocTaskCount =
    adhocInputMode === "json"
      ? adhocJsonAnalysis.tasks?.length ?? 0
      : wAdhocPrompts?.length ?? 0;

  useEffect(() => {
    if (mode === "adhoc" && !adhocJudgeCapable && form.getFieldValue("auto_judge")) {
      form.setFieldValue("auto_judge", false);
    }
  }, [adhocJudgeCapable, form, mode]);

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <h1>{t("newRun.page.title")}</h1>
          <span className="sub">{t("newRun.page.subtitle")}</span>
        </div>
      </div>

      <div className="view">
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            // Switching browser_tool resets Skill to that tool's default.
            if ("browser_tool" in changed) {
              form.setFieldValue("skill_name", btDefaults[changed.browser_tool as string]);
            }
            // task_ids are scoped to a benchmark; switching benchmark clears them so
            // stale ids from the previous dataset can't reach run_eval (sample_tasks
            // raises KeyError on unknown task_id).
            if ("benchmark" in changed) {
              form.setFieldValue("task_ids", []);
            }
          }}
        >
          <div className="modeswitch">
            <button
              type="button"
              className={mode === "dataset" ? "on" : ""}
              onClick={() => setMode("dataset")}
            >
              <span className="k">[1]</span> {t("newRun.modes.dataset")}
            </button>
            <button
              type="button"
              className={mode === "adhoc" ? "on" : ""}
              onClick={() => {
                setMode("adhoc");
                form.setFieldValue("auto_judge", false);
              }}
            >
              <span className="k">[2]</span> {t("newRun.modes.adhoc")}
            </button>
          </div>

          <div className="formwrap">
            <div className="forms">
              {/* 01 — Dataset / Ad-hoc */}
              {mode === "dataset" ? (
                <section className="section">
                  <header>
                    <span className="idx">01</span>
                    <h3>{t("newRun.dataset.title")}</h3>
                    <span className="hint">{t("newRun.dataset.hint")}</span>
                  </header>
                  <div className="body">
                    <div className="grid2">
                      <div className="field span2">
                        <label>{t("newRun.dataset.benchmark")}</label>
                        <Form.Item
                          name="benchmark"
                          noStyle
                          rules={[{ required: true, message: t("newRun.dataset.benchmarkRequired") }]}
                        >
                          <Select
                            showSearch
                            className="mono"
                            placeholder={t("newRun.dataset.selectBenchmark")}
                            options={datasets.map((d) => ({
                              label: `${d.name}${d.count != null ? ` (${d.count})` : ""}`,
                              value: d.name,
                            }))}
                          />
                        </Form.Item>
                        {selected?.categories && (
                          <div className="meta-row">
                            <div className="big">
                              {selected.count ?? "—"}
                              <small>{t("newRun.dataset.tasks")}</small>
                            </div>
                            <div className="meta-sep" />
                            <div className="cats">
                              {Object.entries(selected.categories).map(([k, n]) => (
                                <span className="cat" key={k}>
                                  {k} <b>{n}</b>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="field span2">
                        <label>
                          {t("newRun.dataset.taskIdsField")}{" "}
                          <span className="opt">{t("newRun.dataset.taskIdsHint")}</span>
                        </label>
                        <Form.Item name="task_ids" noStyle>
                          <Select
                            mode="tags"
                            className="mono w-full"
                            placeholder={t("newRun.dataset.taskIdsPlaceholder")}
                            options={taskOptions}
                            tokenSeparators={[","]}
                            optionFilterProp="label"
                            allowClear
                            maxTagCount={8}
                          />
                        </Form.Item>
                        <div className="desc">{t("newRun.dataset.taskIdsDescription")}</div>
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="section">
                  <header>
                    <span className="idx">01</span>
                    <h3>{t("newRun.adhoc.title")}</h3>
                    <span className="hint">{t("newRun.adhoc.hint")}</span>
                  </header>
                  <div className="body">
                    <div className="field adhoc-input-mode">
                      <label>{t("newRun.adhoc.inputFormat")}</label>
                      <SegField
                        options={["tasks", "json"]}
                        labels={adhocInputLabels}
                        value={adhocInputMode}
                        onChange={(value) => {
                          setAdhocInputMode(value as AdhocInputMode);
                          form.setFieldValue("auto_judge", false);
                        }}
                      />
                    </div>

                    {adhocInputMode === "tasks" ? (
                      <Form.List
                        name="adhoc_prompts"
                        initialValue={[""]}
                        rules={[
                          {
                            validator: async (_, prompts) => {
                              if (!prompts?.length) throw new Error(t("newRun.adhoc.atLeastOneTask"));
                            },
                          },
                        ]}
                      >
                        {(fields, { add, remove }, { errors }) => (
                          <div className="adhoc-task-list">
                            {fields.map((field, index) => (
                              <div className="adhoc-task-row" key={field.key}>
                                <div className="adhoc-task-index">
                                  {t("newRun.adhoc.taskLabel", {
                                    index: String(index + 1).padStart(2, "0"),
                                  })}
                                </div>
                                <div className="adhoc-task-editor">
                                  <Form.Item
                                    name={field.name}
                                    noStyle
                                    rules={[
                                      {
                                        required: true,
                                        whitespace: true,
                                        message: t("newRun.adhoc.taskRequired"),
                                      },
                                    ]}
                                  >
                                    <Input.TextArea
                                      className="ta"
                                      rows={3}
                                      placeholder={t("newRun.adhoc.taskPlaceholder")}
                                    />
                                  </Form.Item>
                                </div>
                                <Button
                                  className="adhoc-remove"
                                  size="small"
                                  type="text"
                                  disabled={fields.length === 1}
                                  onClick={() => remove(field.name)}
                                >
                                  {t("newRun.adhoc.remove")}
                                </Button>
                              </div>
                            ))}
                            <Button className="adhoc-add" type="dashed" block onClick={() => add("")}>
                              {t("newRun.adhoc.add")}
                            </Button>
                            <Form.ErrorList errors={errors} />
                            <div className="desc">{t("newRun.adhoc.taskDescription")}</div>
                          </div>
                        )}
                      </Form.List>
                    ) : (
                      <div className="field adhoc-json-field">
                        <label>
                          {t("newRun.adhoc.jsonLabel")}{" "}
                          <span className="opt">{t("newRun.adhoc.jsonHint")}</span>
                        </label>
                        <Form.Item
                          name="adhoc_json"
                          noStyle
                          rules={[
                            {
                              validator: async (_, value) => {
                                const analysis = analyseAdhocJson(value);
                                if (!analysis.tasks || analysis.error) {
                                  throw new Error(
                                    analysis.error
                                      ? adhocErrorText(t, analysis.error)
                                      : t("newRun.adhoc.jsonRequired"),
                                  );
                                }
                              },
                            },
                          ]}
                        >
                          <Input.TextArea
                            className="ta adhoc-json"
                            rows={14}
                            spellCheck={false}
                            placeholder={t("newRun.adhoc.jsonPlaceholder")}
                          />
                        </Form.Item>
                        {adhocJsonError ? (
                          <div className="adhoc-json-status error">{adhocJsonError}</div>
                        ) : adhocJsonAnalysis.tasks ? (
                          <div
                            className={`adhoc-json-status ${
                              adhocJsonAnalysis.judgeCapable ? "ready" : "neutral"
                            }`}
                          >
                            {t("newRun.adhoc.status", {
                              count: adhocJsonAnalysis.tasks.length,
                              state: t(
                                adhocJsonAnalysis.judgeCapable
                                  ? "newRun.adhoc.available"
                                  : "newRun.adhoc.unavailable",
                              ),
                            })}
                          </div>
                        ) : (
                          <div className="desc">{t("newRun.adhoc.jsonDescription")}</div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* 02 — Run */}
              <section className="section">
                <header>
                  <span className="idx">02</span>
                  <h3>{t("newRun.run.title")}</h3>
                  <span className="hint">{t("newRun.run.hint")}</span>
                </header>
                <div className="body">
                  <div className="grid2">
                    <div className="field span2">
                      <label>{t("newRun.run.browserTool")}</label>
                      <Form.Item name="browser_tool" noStyle rules={[{ required: true }]}>
                        <SegField
                          options={browserTools}
                        />
                      </Form.Item>
                    </div>
                    <div className="field span2">
                      <label>
                        {t("newRun.run.skill")} <span className="opt">{t("newRun.run.skillHint")}</span>
                      </label>
                      <Form.Item name="skill_name" noStyle>
                        <Select
                          showSearch
                          className="mono"
                          placeholder={t("newRun.run.skillPlaceholder")}
                          options={skills.map((s) => ({ label: s, value: s }))}
                        />
                      </Form.Item>
                      <div className="desc">{t("newRun.run.skillDescription")}</div>
                    </div>
                    {wTool === "wiek-browser" && <WiekBrowserVersion />}
                    <div className="field">
                      <label>{t("newRun.run.guardMode")}</label>
                      <Form.Item name="browser_tool_mode" noStyle>
                        <SegField options={["strict", "loose", "off"]} labels={guardModeLabels} />
                      </Form.Item>
                    </div>
                    <div className="field">
                      <label>{t("newRun.run.concurrency")}</label>
                      <Form.Item name="concurrency" noStyle>
                        <InputNumber className="w-full mono" min={1} />
                      </Form.Item>
                    </div>
                    <div className="field">
                      <label>{t("newRun.run.iterations")}</label>
                      <Form.Item name="iterations" noStyle>
                        <InputNumber className="w-full mono" min={1} />
                      </Form.Item>
                    </div>
                    <div className="field">
                      <label>{t("newRun.run.retryCount")}</label>
                      <Form.Item name="retry_count" noStyle>
                        <InputNumber className="w-full mono" min={0} />
                      </Form.Item>
                    </div>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <div className={`togrow${mode === "adhoc" && !adhocJudgeCapable ? " disabled" : ""}`}>
                      <div className="tl">
                        <b>{t("newRun.run.autoJudge")}</b>
                        <span>
                          {mode === "adhoc"
                            ? adhocJudgeCapable
                              ? t("newRun.run.autoJudgeAdhocReady")
                              : t("newRun.run.autoJudgeAdhocUnavailable")
                            : t("newRun.run.autoJudgeDataset")}
                        </span>
                      </div>
                      <Form.Item name="auto_judge" valuePropName="checked" noStyle>
                        <Switch disabled={mode === "adhoc" && !adhocJudgeCapable} />
                      </Form.Item>
                    </div>
                    <div className="togrow">
                      <div className="tl">
                        <b>{t("newRun.run.autoExport")}</b>
                        <span>{t("newRun.run.autoExportDescription")}</span>
                      </div>
                      <Form.Item name="auto_export_sessions" valuePropName="checked" noStyle>
                        <Switch />
                      </Form.Item>
                    </div>
                  </div>
                </div>
              </section>

              {/* 03 — Provider */}
              <section className="section">
                <header>
                  <span className="idx">03</span>
                  <h3>{t("newRun.provider.title")}</h3>
                  <span className="hint">{t("newRun.provider.hint")}</span>
                </header>
                <div className="body">
                  <div className="grid2">
                    <div className="field span2">
                      <label>{t("newRun.provider.agentProvider")}</label>
                      <Form.Item name="agent_provider" noStyle>
                        <SegField options={["pi", "codex"]} labels={agentProviderLabels} />
                      </Form.Item>
                    </div>
                    {wAgentProvider === "codex" ? (
                      <>
                        <div className="field">
                          <label>{t("newRun.provider.model")}</label>
                          <Form.Item name="codex_model" noStyle rules={[{ required: true }]}>
                            <AcField
                              placeholder={t("newRun.provider.placeholders.model")}
                              options={codexModelOptions}
                            />
                          </Form.Item>
                          {codexModelsError && (
                            <div className="desc" style={{ color: "#b00020" }}>
                              {t("newRun.provider.modelDiscoveryUnavailable", {
                                detail: codexModelsError,
                              })}
                            </div>
                          )}
                        </div>
                        <div className="field">
                          <label>{t("newRun.provider.serviceTier")}</label>
                          <Form.Item name="codex_service_tier" noStyle>
                            <AcField
                              placeholder={t("newRun.provider.placeholders.serviceTier")}
                              options={codexServiceTierOptions}
                            />
                          </Form.Item>
                        </div>
                        <div className="field span2">
                          <label>{t("newRun.provider.reasoningEffort")}</label>
                          <Form.Item
                            name="codex_reasoning_effort"
                            noStyle
                            rules={[{ required: true }]}
                          >
                            <AcField
                              placeholder={t("newRun.provider.placeholders.reasoningEffort")}
                              options={codexReasoningOptions}
                            />
                          </Form.Item>
                        </div>
                        <div className="field span2">
                          <label>{t("newRun.provider.codexHome")}</label>
                          <Form.Item name="codex_home" noStyle rules={[{ required: true }]}>
                            <Input
                              className="mono"
                              placeholder={t("newRun.provider.placeholders.codexHome")}
                            />
                          </Form.Item>
                          <div className="desc">{t("newRun.provider.codexHomeDescription")}</div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="field">
                          <label>{t("newRun.provider.piModelProvider")}</label>
                          <Form.Item name="pi_provider" noStyle>
                            <AcField
                              placeholder={t("newRun.provider.placeholders.piProvider")}
                              options={providerOptions}
                            />
                          </Form.Item>
                        </div>
                        <div className="field">
                          <label>{t("newRun.provider.model")}</label>
                          <Form.Item name="pi_model" noStyle>
                            <AcField
                              placeholder={t("newRun.provider.placeholders.model")}
                              options={modelOptions}
                            />
                          </Form.Item>
                          <div className="desc">{t("newRun.provider.piModelDescription")}</div>
                        </div>
                        <div className="field span2">
                          <label>{t("newRun.provider.thinking")}</label>
                          <Form.Item name="thinking_level" noStyle>
                            <SegField
                              options={["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
                              labels={thinkingLevelLabels}
                            />
                          </Form.Item>
                        </div>
                        <div className="field span2">
                          <label>{t("newRun.provider.toolProfile")}</label>
                          <Form.Item name="tool_profile" noStyle>
                            <SegField options={["full", "readonly"]} labels={toolProfileLabels} />
                          </Form.Item>
                          <div className="desc">{t("newRun.provider.toolProfileDescription")}</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </section>

              {/* 04 — Limits & judge */}
              <section className="section">
                <header>
                  <span className="idx">04</span>
                  <h3>{t("newRun.limits.title")}</h3>
                  <span className="hint">{t("newRun.limits.hint")}</span>
                </header>
                <div className="body">
                  <div className="grid2">
                    <div className="field">
                      <label>{t("newRun.limits.limitBy")}</label>
                      <Form.Item name="limit_mode" noStyle>
                        <SegField options={["time", "steps"]} labels={limitModeLabels} />
                      </Form.Item>
                      <div className="desc">{t("newRun.limits.limitDescription")}</div>
                    </div>
                    <div className="field">
                      {wLimitMode === "steps" ? (
                        <>
                          <label>
                            {t("newRun.limits.maxTurns")} <span className="opt">{t("newRun.limits.steps")}</span>
                          </label>
                          <Form.Item name="max_turns" noStyle>
                            <InputNumber className="w-full mono" min={1} />
                          </Form.Item>
                        </>
                      ) : (
                        <>
                          <label>
                            {t("newRun.limits.taskTimeout")} <span className="opt">{t("newRun.limits.seconds")}</span>
                          </label>
                          <Form.Item name="task_timeout_seconds" noStyle>
                            <InputNumber className="w-full mono" min={10} />
                          </Form.Item>
                        </>
                      )}
                    </div>
                    <div className="field">
                      <label>{t("newRun.limits.judgeMode")}</label>
                      <Form.Item name="judge_mode" noStyle>
                        <SegField options={["single", "agent"]} labels={judgeModeLabels} />
                      </Form.Item>
                      <div className="desc">{t("newRun.limits.judgeModeDescription")}</div>
                    </div>
                    <div className="field">
                      <label>{t("newRun.limits.judgeModel")}</label>
                      <Form.Item name="judge_model" noStyle>
                        <AcField
                          placeholder={t("newRun.limits.judgeModelPlaceholder")}
                          options={judgeOptions}
                        />
                      </Form.Item>
                      <div className="desc">{t("newRun.limits.judgeModelDescription")}</div>
                    </div>
                    <div className="field">
                      <label>{t("newRun.limits.judgeConcurrency")}</label>
                      <Form.Item name="judge_concurrency" noStyle>
                        <InputNumber className="w-full mono" min={1} />
                      </Form.Item>
                    </div>
                    <div className="field">
                      <label>{t("newRun.limits.maxScreenshots")}</label>
                      <Form.Item name="max_screenshots" noStyle>
                        <InputNumber
                          className="w-full mono"
                          min={0}
                          placeholder={t("newRun.limits.maxScreenshotsPlaceholder")}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            {/* RIGHT — summary rail */}
            <aside className="rail">
              <div className="summary">
                <header>
                  <h4>{t("newRun.summary.title")}</h4>
                  <p>{t("newRun.summary.subtitle")}</p>
                </header>
                {willQueue && (
                  <div className="enq-banner">
                    {t("newRun.summary.queueNotice", { position: queuePosition })}
                  </div>
                )}
                <div className="kv">
                  <div className="row">
                    <span className="k">{t("newRun.summary.mode")}</span>
                    <span className="v acc">{t(mode === "dataset" ? "newRun.modes.dataset" : "newRun.modes.adhoc")}</span>
                  </div>
                  {mode === "dataset" ? (
                    <>
                      <div className="row">
                        <span className="k">{t("newRun.summary.benchmark")}</span>
                        <span className="v">{wBenchmark || "—"}</span>
                      </div>
                      <div className="row">
                        <span className="k">{t("newRun.summary.tasksSelected")}</span>
                        <span className="v">{wTaskIds?.length || selected?.count || "—"}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="row">
                        <span className="k">{t("newRun.summary.input")}</span>
                        <span className="v">{t(`newRun.adhoc.inputModes.${adhocInputMode}`)}</span>
                      </div>
                      <div className="row">
                        <span className="k">{t("newRun.summary.tasks")}</span>
                        <span className="v">{adhocTaskCount || "—"}</span>
                      </div>
                    </>
                  )}
                  <div className="row">
                    <span className="k">{t("newRun.summary.browserTool")}</span>
                    <span className="v">{wTool || "—"}</span>
                  </div>
                  <div className="row">
                    <span className="k">{t("newRun.summary.skill")}</span>
                    <span className="v">{wSkill || "—"}</span>
                  </div>
                  <div className="row">
                    <span className="k">{t("newRun.summary.guard")}</span>
                    <span className="v">{guardModeLabels[wGuard] || wGuard || "—"}</span>
                  </div>
                  <div className="row">
                    <span className="k">{t("newRun.summary.concurrency")}</span>
                    <span className="v">{wConc ?? "—"}</span>
                  </div>
                  <div className="row">
                    <span className="k">{t("newRun.summary.provider")}</span>
                    <span className="v">
                      {agentProviderLabels[wAgentProvider] || wAgentProvider}
                    </span>
                  </div>
                  {wAgentProvider === "pi" && (
                    <div className="row">
                      <span className="k">{t("newRun.summary.modelProvider")}</span>
                      <span className="v">{wPiProvider || "—"}</span>
                    </div>
                  )}
                  <div className="row">
                    <span className="k">{t("newRun.summary.model")}</span>
                    <span className="v">
                      {wModel || "—"}
                      {wThinking
                        ? ` · ${thinkingLevelLabels[wThinking] || wThinking}`
                        : ""}
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">{t("newRun.summary.autoJudge")}</span>
                    <span className="v acc">
                      {t(wJudge ? "common.states.on" : "common.states.off")}
                    </span>
                  </div>
                </div>
                <footer>
                  <Button type="primary" block size="large" loading={starting} onClick={submit}>
                    {willQueue
                      ? t("newRun.summary.enqueue", { position: queuePosition })
                      : t("newRun.summary.start")}
                  </Button>
                  <div className="est">{t("newRun.summary.mapping")}</div>
                </footer>
              </div>

              <div className="tip">
                <svg
                  className="ico"
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 7.5v3.5M8 5h.01" />
                </svg>
                <div>
                  <Trans
                    i18nKey="newRun.summary.cliParity"
                    components={{
                      code: <code style={{ fontFamily: "var(--mono)", fontSize: 11 }} />,
                    }}
                  />
                </div>
              </div>
            </aside>
          </div>
        </Form>
      </div>
    </>
  );
}
