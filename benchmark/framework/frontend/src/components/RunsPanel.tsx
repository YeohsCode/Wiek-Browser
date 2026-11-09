import { useEffect, useMemo, useState } from "react";
import { App as AntdApp, InputNumber, Select } from "antd";
import { useTranslation } from "react-i18next";
import { api, RunInfo } from "../api";
import { formatDateTime } from "../i18n/format";
import { appLocale, type AppLocale } from "../i18n";
import { buildRunForest, flattenRunForest } from "../runHierarchy";
import {
  modelFilterKey,
  resolveFilterPreference,
  useScopeFilterPreference,
} from "../useScopeFilterPreference";
import { useRuntimeMismatchConfirm } from "../useRuntimeMismatchConfirm";
import Ico from "./Ico";

interface Props {
  refreshKey: number;
  onReuse: (runId: string) => void;
  onOpenProgress: (runId: string) => void;
  onCounts: (total: number) => void;
  onNewRun: () => void;
}

const TOOL_COLOR: Record<string, string> = {
  "wiek-browser": "#3b6ea5",
};

function toolColor(tool: string | null): string {
  return tool && TOOL_COLOR[tool] ? TOOL_COLOR[tool] : "var(--ink-3)";
}

function fmtWhen(completedAt: string | null, locale: AppLocale, liveLabel: string): string {
  if (!completedAt) return liveLabel;
  const d = new Date(completedAt);
  return isNaN(d.getTime()) ? completedAt : formatDateTime(d, locale);
}

interface TaskOpt {
  task_id: string;
  status: string;
}

const isBad = (s: string) => s === "fail" || s === "error";

// Export-dialog task exclusion uses searchable multi-select with free input
// allowed (base_task_id matches all its iters server-side; unmatched specs are
// inert — the report meta is the source of truth).
function ExcludePicker({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: { value: string; label: string }[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className="baselbl" style={{ marginTop: 16 }}>
        {t("runs.exclude.label")}
      </div>
      <Select
        mode="tags"
        style={{ width: "100%" }}
        placeholder={t("runs.exclude.placeholder")}
        value={value}
        options={options}
        onChange={onChange}
        tokenSeparators={[","]}
        optionFilterProp="value"
        allowClear
        maxTagCount={6}
      />
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
        {t("runs.exclude.description")}
      </div>
    </>
  );
}

// dataset bucket for a run; null benchmark (ad-hoc runs) folds into "ad-hoc".
const datasetKey = (r: RunInfo): string => r.benchmark || "ad-hoc";
const providerKey = (r: RunInfo): string => r.provider || "unknown";

export default function RunsPanel({ refreshKey, onReuse, onOpenProgress, onCounts, onNewRun }: Props) {
  const { message, modal } = AntdApp.useApp();
  const { t, i18n } = useTranslation();
  const confirmRuntimeMismatch = useRuntimeMismatchConfirm();
  const locale = appLocale(i18n.resolvedLanguage);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // run_id substring search + provider → model → dataset scope; filters narrow the table only.
  const [query, setQuery] = useState("");
  const { preference, selectProvider, selectModel, selectDataset } = useScopeFilterPreference("runs");
  const [reportOpen, setReportOpen] = useState(false);
  // Reset task exclusions whenever the export dialog opens.
  const [exclude, setExclude] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // Per-run task lists for the exclude candidates, lazily fetched via the
  // progress endpoint because there is no dedicated tasks endpoint.
  const [taskCache, setTaskCache] = useState<Record<string, TaskOpt[]>>({});
  // A null pending-delete run id means the modal is closed.
  const [delTarget, setDelTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Resume target and concurrency for the in-place continuation dialog.
  const [resumeTarget, setResumeTarget] = useState<string | null>(null);
  const [resumeConc, setResumeConc] = useState<number | null>(null);
  const [resuming, setResuming] = useState(false);
  // Derived rejudge rows start collapsed under their persisted parent. Keep only the
  // user's disclosure choices; the tree itself is derived directly from the API payload.
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());
  // Runs and Artifacts share runs/<id>/note.md. The list payload drives the content
  // indicator; opening always re-reads the note so the modal shows the latest edit.
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [openingNote, setOpeningNote] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const ensureTasks = (ids: string[]) =>
    ids
      .filter((id) => !(id in taskCache))
      .forEach((id) =>
        api
          .progress(id)
          .then((p) =>
            setTaskCache((c) => ({
              ...c,
              [id]: p.tasks.map((t) => ({ task_id: t.task_id, status: t.status })),
            })),
          )
          .catch(() => setTaskCache((c) => ({ ...c, [id]: [] }))),
      );

  // Dedup by task_id across runs (an exclude spec applies to every involved run);
  // fail/error first — the row you want to drop is usually the broken one.
  const excludeOptions = (runIds: string[]) => {
    const taskStatusLabel = (status: string): string => {
      switch (status) {
        case "running":
          return t("runs.states.running");
        case "done":
          return t("runs.states.done");
        case "fail":
          return t("runs.states.fail");
        case "error":
          return t("runs.states.error");
        case "skip":
          return t("runs.states.skip");
        case "stopped":
          return t("runs.states.stopped");
        case "queued":
          return t("runs.states.queued");
        default:
          return status;
      }
    };
    const seen = new Map<string, string>();
    runIds.forEach((id) =>
      (taskCache[id] ?? []).forEach((t) => {
        const prev = seen.get(t.task_id);
        if (prev === undefined || (isBad(t.status) && !isBad(prev))) seen.set(t.task_id, t.status);
      }),
    );
    return [...seen.entries()]
      .sort((a, b) => Number(isBad(b[1])) - Number(isBad(a[1])) || a[0].localeCompare(b[0]))
      .map(([tid, st]) => ({ value: tid, label: `${tid} · ${taskStatusLabel(st)}` }));
  };

  // Queue pause state is fetched alongside the runs rather than read off a queued row:
  // pausing an empty queue is legal, and deriving the flag from rows would leave that
  // state with no resume affordance anywhere in the UI.
  const loadRuns = () =>
    Promise.all([api.runs(), api.queue().catch(() => null)])
      .then(([rs, queue]) => {
        setRuns(rs);
        if (queue) setQueuePaused(queue.paused);
        onCounts(rs.length);
        return rs;
      })
      .catch((e) => {
        message.error(String(e));
        return [] as RunInfo[];
      });

  // Poll only while a run is live: a list with no running/judging run is static on
  // disk, so polling stops. A judge-only re-judge keeps the run "done" but live,
  // so it counts as live
  // here too — else the list freezes mid-rejudge. Self-scheduling via setTimeout so
  // each tick re-decides; refreshKey re-mounts to resume.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () =>
      loadRuns().then((rs) => {
        // Queued rows count as live: the list must keep polling to catch the moment
        // the scheduler releases one, even when nothing is executing right now.
        if (!stopped && rs.some((r) => r.running || r.judging || r.queued))
          timer = setTimeout(tick, 5000);
      });
    tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  const toggleChildren = (id: string) =>
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stop = async (id: string) => {
    await api.stopRun(id);
    message.info(t("runs.feedback.stopSignalled", { runId: id }));
  };

  // --- queue actions ---------------------------------------------------------

  const runQueueAction = async (action: () => Promise<unknown>, feedback?: string) => {
    try {
      await action();
      if (feedback) message.success(feedback);
      await loadRuns();
    } catch (e) {
      message.error(String(e));
    }
  };

  const queueStartNow = (id: string) =>
    runQueueAction(() => api.queueStartNow(id), t("runs.feedback.queueStarted", { runId: id }));

  const queueToTop = (id: string) => runQueueAction(() => api.queueMove(id, { top: true }));

  const queueTogglePause = () =>
    runQueueAction(
      () => api.queuePause(!queuePaused),
      queuePaused ? t("runs.feedback.queueResumed") : t("runs.feedback.queuePaused"),
    );

  const queueCancel = (id: string) =>
    modal.confirm({
      title: t("runs.queue.cancelDialog.title", { runId: id }),
      content: t("runs.queue.cancelDialog.content"),
      okText: t("runs.queue.cancelDialog.confirm"),
      cancelText: t("common.actions.cancel"),
      okButtonProps: { danger: true },
      onOk: () =>
        runQueueAction(() => api.deleteRun(id), t("runs.feedback.queueCancelled", { runId: id })),
    });

  // One-click rerun overwrites a run's failed task records and
  // records + products, then jumps to the progress view to watch it.
  const rerunErrors = (runId: string, fail: number) =>
    modal.confirm({
      title: t("runs.rerunDialog.title", { count: fail, runId }),
      content: t("runs.rerunDialog.content"),
      okText: t("runs.rerunDialog.confirm"),
      cancelText: t("common.actions.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const started = await confirmRuntimeMismatch((allow) =>
            api.rerun(runId, { errors: true, allow_runtime_mismatch: allow }),
          );
          if (!started) return; // declined the runtime question: close, having launched nothing
          message.success(t("runs.feedback.rerunStarted", { runId }));
          onOpenProgress(runId);
        } catch (e) {
          message.error(String(e));
          throw e; // keep the dialog open on failure
        }
      },
    });

  // Resume a stopped or cancelled run in place by prefilling concurrency
  // with the run's original, then continue the unfinished tasks (same run_id).
  const openResume = (r: RunInfo) => {
    setResumeConc(r.concurrency ?? null);
    setResumeTarget(r.run_id);
  };

  const confirmResume = async () => {
    if (!resumeTarget) return;
    setResuming(true);
    try {
      const started = await confirmRuntimeMismatch((allow) =>
        api.resume(resumeTarget, {
          ...(resumeConc != null ? { concurrency: resumeConc } : {}),
          allow_runtime_mismatch: allow,
        }),
      );
      if (!started) return; // declined: keep the resume dialog open for a different choice
      message.success(t("runs.feedback.resumeStarted", { runId: resumeTarget }));
      const id = resumeTarget;
      setResumeTarget(null);
      onOpenProgress(id);
    } catch (e) {
      message.error(String(e));
    } finally {
      setResuming(false);
    }
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await api.deleteRun(delTarget);
      message.success(t("runs.feedback.deleted", { runId: delTarget }));
      setSelected((s) => s.filter((x) => x !== delTarget));
      setDelTarget(null);
      loadRuns();
    } catch (e) {
      message.error(String(e));
    } finally {
      setDeleting(false);
    }
  };

  const openNote = async (run: RunInfo) => {
    setOpeningNote(run.run_id);
    try {
      const { note } = await api.getNote(run.run_id);
      setRuns((current) =>
        current.map((item) => (item.run_id === run.run_id ? { ...item, note } : item)),
      );
      setNoteDraft(note);
      setNoteTarget(run.run_id);
    } catch (e) {
      message.error(String(e));
    } finally {
      setOpeningNote(null);
    }
  };

  const saveNote = async () => {
    if (!noteTarget) return;
    setSavingNote(true);
    try {
      const { note } = await api.putNote(noteTarget, noteDraft);
      setRuns((current) =>
        current.map((item) => (item.run_id === noteTarget ? { ...item, note } : item)),
      );
      setNoteTarget(null);
      message.success(note ? t("runs.feedback.noteSaved") : t("runs.feedback.noteCleared"));
    } catch (e) {
      message.error(String(e));
    } finally {
      setSavingNote(false);
    }
  };

  const exportSessions = async () => {
    if (!selected.length) return message.warning(t("runs.feedback.selectRun"));
    try {
      const { path } = await api.exportSessions(selected);
      message.success(t("runs.feedback.exported", { path }));
    } catch (e) {
      message.error(String(e));
    }
  };

  const openReport = () => {
    if (!selected.length) return message.warning(t("runs.feedback.selectRun"));
    setExclude([]);
    ensureTasks(selected);
    setReportOpen(true);
  };

  const doExportReport = async () => {
    setExporting(true);
    try {
      const { path } = await api.exportSingle(selected, { exclude, locale });
      message.success(t("runs.feedback.reportExported", { path }));
      setReportOpen(false);
    } catch (e) {
      message.error(String(e));
    } finally {
      setExporting(false);
    }
  };

  const active = runs.filter((r) => r.running || r.judging).length;
  const selNote =
    selected.length === 1 ? selected[0] : selected.length ? t("runs.count", { count: selected.length }) : "";

  // Search narrows first; provider then model scope the dataset choices. Derive the
  // projection during render so all three filter rows share the visible run set.
  const q = query.trim().toLowerCase();
  // Queued runs are shown as their own group pinned to the top of the table, so they
  // stay out of the provider/model/dataset filters and out of the derived-run forest:
  // nothing has executed yet, and a filter hiding what is about to run would be a trap.
  // They still honour the id search, which is a "find this run" action, not a facet.
  const queuedRuns = useMemo(
    () => runs.filter((r) => r.queued && (!q || r.run_id.toLowerCase().includes(q))),
    [runs, q],
  );
  const started = useMemo(() => runs.filter((r) => !r.queued), [runs]);

  const filterView = useMemo(() => {
    const providerKeys = new Set<string>();
    for (const r of started) providerKeys.add(providerKey(r));
    const providerFilter = resolveFilterPreference(preference.provider, providerKeys);

    const modelKeys = new Set<string>();
    for (const r of started) {
      if (providerFilter === "all" || providerKey(r) === providerFilter) modelKeys.add(modelFilterKey(r.model));
    }
    const modelFilter =
      providerFilter === preference.provider
        ? resolveFilterPreference(preference.model, modelKeys)
        : "all";

    const datasetKeys = new Set<string>();
    for (const r of started) {
      if (
        (providerFilter === "all" || providerKey(r) === providerFilter) &&
        (modelFilter === "all" || modelFilterKey(r.model) === modelFilter)
      ) {
        datasetKeys.add(datasetKey(r));
      }
    }
    const cat =
      providerFilter === preference.provider && modelFilter === preference.model
        ? resolveFilterPreference(preference.dataset, datasetKeys)
        : "all";

    const searched = q ? started.filter((r) => r.run_id.toLowerCase().includes(q)) : started;
    const providerCounts = new Map<string, number>();
    // Keep provider buttons stable while searching; their counts still reflect the query.
    for (const r of started) providerCounts.set(providerKey(r), 0);

    const providerScoped: RunInfo[] = [];
    for (const r of searched) {
      const key = providerKey(r);
      providerCounts.set(key, (providerCounts.get(key) ?? 0) + 1);
      if (providerFilter === "all" || key === providerFilter) providerScoped.push(r);
    }

    const modelCounts = new Map<string, number>();
    const modelScoped: RunInfo[] = [];
    for (const r of providerScoped) {
      const key = modelFilterKey(r.model);
      modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
      if (modelFilter === "all" || key === modelFilter) modelScoped.push(r);
    }

    const catCounts = new Map<string, number>();
    const visible: RunInfo[] = [];
    for (const r of modelScoped) {
      const key = datasetKey(r);
      catCounts.set(key, (catCounts.get(key) ?? 0) + 1);
      if (cat === "all" || key === cat) visible.push(r);
    }

    return {
      searchedCount: searched.length,
      providerTotal: providerScoped.length,
      modelTotal: modelScoped.length,
      providerFilter,
      modelFilter,
      cat,
      providers: [...providerCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      models: [...modelCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      cats: [...catCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      visible,
    };
  }, [started, q, preference.provider, preference.model, preference.dataset]);
  const visibleRows = useMemo(
    () => flattenRunForest(buildRunForest(filterView.visible), expandedRuns, Boolean(q)),
    [filterView.visible, expandedRuns, q],
  );

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <h1>{t("runs.title")}</h1>
          <span className="sub">
            {t("runs.subtitle", { count: runs.length, active })}
          </span>
        </div>
        <div className="acts">
          <button type="button" className="btn primary" onClick={onNewRun}>
            <Ico>
              <path d="M8 3v10M3 8h10" />
            </Ico>
            {t("runs.actions.newRun")}
          </button>
        </div>
      </div>

      <div className="view">
        <div className="toolbar">
          <div className="searchbox">
            <Ico w={14}>
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.2 10.2L14 14" />
            </Ico>
            <input
              type="text"
              placeholder={t("runs.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("runs.search.label")}
            />
            {query && (
              <button
                type="button"
                className="clear"
                aria-label={t("runs.search.clear")}
                onClick={() => setQuery("")}
              >
                ✕
              </button>
            )}
          </div>
          <span className="sep" />
          <button type="button" className="btn" onClick={loadRuns}>
            <Ico>
              <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
            </Ico>
            {t("runs.actions.refresh")}
          </button>
          <span className="sep" />
          <button type="button" className="btn" disabled={!selected.length} onClick={exportSessions}>
            <Ico>
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
            </Ico>
            {t("runs.actions.exportSessions")}
          </button>
          <button type="button" className="btn" disabled={!selected.length} onClick={openReport}>
            <Ico>
              <rect x="3" y="2.5" width="10" height="11" rx="1.4" />
              <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
            </Ico>
            {t("runs.actions.reportSelected")}
          </button>
          {selNote && (
            <span className="selnote">
              {t("runs.selected", { value: selNote })}
            </span>
          )}
        </div>

        {runs.length > 0 && (
          <div className="scopefilters" role="group" aria-label={t("runs.filters.label")}>
            <div className="scopefilter-row provider-row">
              <span className="scopefilter-label">{t("runs.filters.provider")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.providerFilter === "all" ? "on" : ""}
                  onClick={() => selectProvider("all")}
                >
                  {t("runs.filters.all", { count: filterView.searchedCount })}
                </button>
                {filterView.providers.map(([k, n]) => (
                  <button
                    type="button"
                    key={k}
                    className={filterView.providerFilter === k ? "on" : ""}
                    onClick={() => selectProvider(k)}
                  >
                    {k} · {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="scopefilter-row">
              <span className="scopefilter-label">{t("runs.filters.model")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.modelFilter === "all" ? "on" : ""}
                  onClick={() => selectModel(filterView.providerFilter, "all")}
                >
                  {t("runs.filters.all", { count: filterView.providerTotal })}
                </button>
                {filterView.models.map(([k, n]) => (
                  <button
                    type="button"
                    key={k}
                    className={filterView.modelFilter === k ? "on" : ""}
                    onClick={() => selectModel(filterView.providerFilter, k)}
                  >
                    {k} · {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="scopefilter-row">
              <span className="scopefilter-label">{t("runs.filters.dataset")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.cat === "all" ? "on" : ""}
                  onClick={() => selectDataset(filterView.providerFilter, filterView.modelFilter, "all")}
                >
                  {t("runs.filters.all", { count: filterView.modelTotal })}
                </button>
                {filterView.cats.map(([k, n]) => (
                  <button
                    type="button"
                    key={k}
                    className={filterView.cat === k ? "on" : ""}
                    onClick={() => selectDataset(filterView.providerFilter, filterView.modelFilter, k)}
                  >
                    {k} · {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="tablecard">
          <table className="runs">
            <thead>
              <tr>
                <th style={{ width: 34 }}></th>
                <th>{t("runs.table.runId")}</th>
                <th>{t("runs.table.benchmark")}</th>
                <th>{t("runs.table.tool")}</th>
                <th style={{ width: 170 }}>{t("runs.table.doneFail")}</th>
                <th>{t("runs.table.status")}</th>
                <th style={{ textAlign: "right" }}>{t("runs.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {/* Shown while anything waits, and also while the queue is merely paused:
                  otherwise pausing an empty queue hides its own resume button. */}
              {(queuedRuns.length > 0 || queuePaused) && (
                <tr className="qgroup">
                  <td colSpan={7}>
                    <div className="qgroup-lbl">
                      <span className="qgroup-title">
                        {t("runs.queue.groupTitle", { count: queuedRuns.length })}
                      </span>
                      <span className="qgroup-why">
                        {queuedRuns.length === 0
                          ? t("runs.queue.emptyPaused")
                          : t("runs.queue.groupHint")}
                      </span>
                      <button type="button" className="qgroup-act" onClick={queueTogglePause}>
                        {queuePaused ? t("runs.queue.resumeQueue") : t("runs.queue.pauseQueue")}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {queuedRuns.map((r) => (
                <tr className="qrow" key={r.run_id}>
                  <td>
                    <span className="qpos">{r.queue_position}</span>
                  </td>
                  <td>
                    <div className="run-tree-cell">
                      <span className="tree-spacer" />
                      <div className="rid">
                        <div className="run-id-line">
                          <span>{r.run_id}</span>
                        </div>
                        <small>
                          {r.queue_error
                            ? r.queue_error
                            : r.queue_position === 1
                              ? t("runs.queue.nextUp")
                              : t("runs.queue.waitingAt", { position: r.queue_position ?? 0 })}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td className="tcell" style={r.benchmark ? undefined : { color: "var(--ink-3)" }}>
                    {r.benchmark || t("runs.table.adhoc")}
                  </td>
                  <td>
                    <span className="toolchip">
                      <span className="sw" style={{ background: toolColor(r.browser_tool) }} />
                      {r.browser_tool || "—"}
                    </span>
                  </td>
                  <td>
                    <div className="donefail">
                      <div className="nums" style={{ color: "var(--ink-3)" }}>
                        — / —{" "}
                        {r.task_count_planned ? (
                          <span className="of">
                            {t("runs.table.of", { count: r.task_count_planned })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${queuePaused ? "stopped" : "queued qpill"}`}>
                      <span className="dot" />
                      {queuePaused ? t("runs.queue.held") : t("runs.states.queued")}
                    </span>
                  </td>
                  <td>
                    <div className="rowacts">
                      {r.queue_position !== 1 && (
                        <button
                          type="button"
                          className="iconbtn"
                          title={t("runs.queue.moveTop")}
                          onClick={() => queueToTop(r.run_id)}
                        >
                          <Ico w={15}>
                            <path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" />
                          </Ico>
                        </button>
                      )}
                      <button
                        type="button"
                        className="iconbtn"
                        title={t("runs.queue.startNow")}
                        onClick={() => queueStartNow(r.run_id)}
                      >
                        <Ico w={15}>
                          <path d="M5 3.5v9l7-4.5z" />
                        </Ico>
                      </button>
                      <button
                        type="button"
                        className="iconbtn"
                        title={t("runs.actions.reuseConfig")}
                        onClick={() => onReuse(r.run_id)}
                      >
                        <Ico w={15}>
                          <rect x="3" y="3" width="7" height="7" rx="1.3" />
                          <path d="M6 13h7V6" />
                        </Ico>
                      </button>
                      <button
                        type="button"
                        className="iconbtn del"
                        title={t("runs.queue.cancel")}
                        onClick={() => queueCancel(r.run_id)}
                      >
                        <Ico w={15}>
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </Ico>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleRows.map(({ item: r, depth, childCount }) => {
                const captchaN = r.captcha ?? 0;
                const total = r.task_count_planned ?? r.done + r.fail + captchaN;
                // Liveness drives the action gate: only a live subprocess blocks delete
                // and offers stop. A crashed run (no completed_at, not running) is
                // deletable — never inferred from completed_at. `busy` folds in a
                // A judge-only re-judge leaves the run "done" while a writer is live, so
                // delete/rerun/resume must stay hidden (they'd 409). Stop covers BOTH —
                // the same /stop endpoint signals either live handle.
                const isRunning = r.running;
                const busy = r.running || r.judging;
                const status = r.running
                  ? "running"
                  : r.judging
                    ? "judging"
                    : r.completed_at
                      ? "done"
                      : "error";
                const statusLabel =
                  status === "running"
                    ? t("runs.states.running")
                    : status === "judging"
                      ? t("runs.states.judging")
                      : status === "done"
                        ? t("runs.states.done")
                        : t("runs.states.error");
                const expanded = Boolean(q) || expandedRuns.has(r.run_id);
                return (
                  <tr
                    key={r.run_id}
                    className={`${selected.includes(r.run_id) ? "sel" : ""} ${depth > 0 ? "run-child" : ""}`.trim()}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox lg"
                        checked={selected.includes(r.run_id)}
                        onChange={(e) => toggle(r.run_id, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="run-tree-cell" style={{ paddingLeft: depth * 20 }}>
                        {childCount > 0 ? (
                          <button
                            type="button"
                            className="tree-toggle"
                            aria-expanded={expanded}
                            aria-label={t("runs.tree.toggle", {
                              action: expanded ? t("runs.tree.collapse") : t("runs.tree.expand"),
                              count: childCount,
                            })}
                            onClick={() => toggleChildren(r.run_id)}
                          >
                            <Ico w={13}>
                              <path d={expanded ? "M3.5 5.5L8 10l4.5-4.5" : "M5.5 3.5L10 8l-4.5 4.5"} />
                            </Ico>
                          </button>
                        ) : depth > 0 ? (
                          <span className="tree-branch">↳</span>
                        ) : (
                          <span className="tree-spacer" />
                        )}
                        <div className="rid">
                          <div className="run-id-line">
                            <span>{r.run_id}</span>
                            {/* Only external runs are badged: console-started is the
                                default, and labelling it would be noise on every row. */}
                            {r.origin === "cli" && (
                              <span className="origin-chip" title={t("runs.origin.cliTitle")}>
                                {t("runs.origin.cli")}
                              </span>
                            )}
                            {r.derived_from && (
                              <span
                                className="derived-chip"
                                title={t("runs.tree.derivedFrom", { runId: r.derived_from })}
                              >
                                {t("runs.tree.rejudge")}
                              </span>
                            )}
                            {childCount > 0 && (
                              <span className="run-child-count">
                                {t("runs.tree.children", { count: childCount })}
                              </span>
                            )}
                          </div>
                          <small>{fmtWhen(r.completed_at, locale, t("runs.states.live"))}</small>
                        </div>
                      </div>
                    </td>
                    <td className="tcell" style={r.benchmark ? undefined : { color: "var(--ink-3)" }}>
                      {r.benchmark || t("runs.table.adhoc")}
                    </td>
                    <td>
                      <span className="toolchip">
                        <span className="sw" style={{ background: toolColor(r.browser_tool) }} />
                        {r.browser_tool || "—"}
                      </span>
                    </td>
                    <td>
                      <div className="donefail">
                        <div className="nums">
                          <span className="d">{r.done}</span> / <span className="f">{r.fail}</span>{" "}
                          {/* Anti-bot walls get their own amber count so they never read as
                              failures of the agent. Hidden when the run hit none. */}
                          {captchaN > 0 && (
                            <span className="cap" title={t("runs.table.captchaTitle")}>
                              ⚠{captchaN}{" "}
                            </span>
                          )}
                          {r.task_count_planned ? (
                            <span className="of">{t("runs.table.of", { count: r.task_count_planned })}</span>
                          ) : null}
                        </div>
                        <div className="bar">
                          {total > 0 && <i className="d" style={{ width: `${(r.done / total) * 100}%` }} />}
                          {total > 0 && <i className="f" style={{ width: `${(r.fail / total) * 100}%` }} />}
                          {total > 0 && captchaN > 0 && (
                            <i className="e" style={{ width: `${(captchaN / total) * 100}%` }} />
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${status}`}>
                        <span className="dot" />
                        {statusLabel}
                      </span>
                      {/* Which stage owns the run tells the user why a queued run may
                          already be starting: Stage B no longer holds the slot. */}
                      {r.running && r.stage && (
                        <div className={`stage-chip ${r.stage === "A" ? "a" : "b"}`}>
                          <i>{r.stage}</i>
                          {r.stage === "A" ? t("runs.stage.holding") : t("runs.stage.released")}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="rowacts">
                        <button
                          type="button"
                          className="iconbtn"
                          title={t("runs.actions.progress")}
                          onClick={() => onOpenProgress(r.run_id)}
                        >
                          <Ico w={15}>
                            <circle cx="8" cy="8" r="5.5" />
                            <path d="M8 8l2.4-2.4" />
                          </Ico>
                        </button>
                        <button
                          type="button"
                          className="iconbtn"
                          title={t("runs.actions.reuseConfig")}
                          onClick={() => onReuse(r.run_id)}
                        >
                          <Ico w={15}>
                            <rect x="3" y="3" width="7" height="7" rx="1.3" />
                            <path d="M6 13h7V6" />
                          </Ico>
                        </button>
                        <button
                          type="button"
                          className={`iconbtn note ${r.note ? "has-note" : ""}`.trim()}
                          title={r.note ? t("runs.actions.viewNote") : t("runs.actions.addNote")}
                          aria-label={
                            r.note
                              ? t("runs.actions.viewNoteFor", { runId: r.run_id })
                              : t("runs.actions.addNoteFor", { runId: r.run_id })
                          }
                          disabled={openingNote === r.run_id}
                          onClick={() => openNote(r)}
                        >
                          <Ico w={15}>
                            <path d="M3 3.5h10v7H8L5 13v-2.5H3z" />
                            <path d="M5.5 6h5M5.5 8h3.5" />
                          </Ico>
                        </button>
                        {r.fail > 0 && !busy && (
                          <button
                            type="button"
                            className="iconbtn"
                            title={t("runs.actions.rerunErrors", { count: r.fail })}
                            onClick={() => rerunErrors(r.run_id, r.fail)}
                          >
                            <Ico w={15}>
                              <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
                            </Ico>
                          </button>
                        )}
                        {r.cancelled && !busy && (
                          <button
                            type="button"
                            className="iconbtn"
                            title={t("runs.actions.resume")}
                            onClick={() => openResume(r)}
                          >
                            <Ico w={15}>
                              <path d="M5 3.5v9l7-4.5z" />
                            </Ico>
                          </button>
                        )}
                        {busy ? (
                          <button
                            type="button"
                            className="iconbtn stop"
                            title={isRunning ? t("runs.actions.stop") : t("runs.actions.stopRejudge")}
                            onClick={() => stop(r.run_id)}
                          >
                            <Ico w={15}>
                              <rect x="4" y="4" width="8" height="8" rx="1.4" />
                            </Ico>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="iconbtn del"
                            title={t("runs.actions.delete")}
                            onClick={() => setDelTarget(r.run_id)}
                          >
                            <Ico w={15}>
                              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />
                            </Ico>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleRows.length === 0 && (
            <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
              {runs.length === 0 ? t("runs.empty.none") : t("runs.empty.filtered")}
            </div>
          )}
        </div>
      </div>

      {reportOpen && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setReportOpen(false);
          }}
        >
          <div className="modal">
            <header>
              <div className="mi">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <rect x="3" y="2.5" width="10" height="11" rx="1.4" />
                  <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
                </svg>
              </div>
              <div>
                <h3>{t("runs.exportDialog.title")}</h3>
                <p>{t("runs.exportDialog.subtitle")}</p>
              </div>
              <button type="button" className="btn ghost sm x" onClick={() => setReportOpen(false)}>
                ✕
              </button>
            </header>
            <div className="mbody">
              <div className="testrow">
                <span className="tag">{t("runs.exportDialog.tag")}</span>
                <span className="rid">{selNote || t("runs.exportDialog.noneSelected")}</span>
              </div>

              <ExcludePicker
                value={exclude}
                options={excludeOptions(selected)}
                onChange={setExclude}
              />

              <div className="download-note">
                <Ico>
                  <path d="M8 2v8M5 7l3 3 3-3" />
                  <path d="M3 13h10" />
                </Ico>
                <div>{t("runs.exportDialog.destination")}</div>
              </div>
            </div>
            <footer>
              <button type="button" className="btn ghost" onClick={() => setReportOpen(false)}>
                {t("common.actions.cancel")}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!selected.length || exporting}
                onClick={doExportReport}
              >
                <Ico>
                  <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
                </Ico>
                {exporting ? t("runs.exportDialog.exporting") : t("runs.exportDialog.confirm")}
              </button>
            </footer>
          </div>
        </div>
      )}

      {noteTarget && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && !savingNote) setNoteTarget(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-note-title"
            style={{ width: "min(560px, 100%)" }}
          >
            <header>
              <div className="mi">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <path d="M3 3.5h10v7H8L5 13v-2.5H3z" />
                  <path d="M5.5 6h5M5.5 8h3.5" />
                </svg>
              </div>
              <div>
                <h3 id="run-note-title">{t("runs.noteDialog.title")}</h3>
                <p>{t("runs.noteDialog.subtitle")}</p>
              </div>
              <button
                type="button"
                className="btn ghost sm x"
                disabled={savingNote}
                onClick={() => setNoteTarget(null)}
              >
                ✕
              </button>
            </header>
            <div className="mbody">
              <div className="testrow">
                <span className="tag">{t("runs.noteDialog.tag")}</span>
                <span className="rid">{noteTarget}</span>
              </div>
              <label className="baselbl" htmlFor="run-note-input">
                {t("runs.noteDialog.label")}
              </label>
              <textarea
                id="run-note-input"
                className="run-note-input"
                value={noteDraft}
                autoFocus
                disabled={savingNote}
                placeholder={t("runs.noteDialog.placeholder")}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
              <div className="run-note-help">{t("runs.noteDialog.help")}</div>
            </div>
            <footer>
              <button type="button" className="btn ghost" disabled={savingNote} onClick={() => setNoteTarget(null)}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="btn primary" disabled={savingNote} onClick={saveNote}>
                <Ico>
                  <path d="M3 3h10v10H3zM5 3v4h6V3M5.5 10.5h5" />
                </Ico>
                {savingNote ? t("runs.noteDialog.saving") : t("runs.noteDialog.save")}
              </button>
            </footer>
          </div>
        </div>
      )}

      {delTarget && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDelTarget(null);
          }}
        >
          <div className="modal" style={{ width: "min(460px, 100%)" }}>
            <header>
              <div className="mi" style={{ background: "var(--fail-soft)", color: "var(--fail)" }}>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />
                </svg>
              </div>
              <div>
                <h3>{t("runs.deleteDialog.title")}</h3>
                <p>{t("runs.deleteDialog.subtitle")}</p>
              </div>
              <button type="button" className="btn ghost sm x" onClick={() => setDelTarget(null)}>
                ✕
              </button>
            </header>
            <div className="mbody">
              <div className="testrow" style={{ background: "var(--fail-soft)", borderColor: "var(--fail)" }}>
                <span className="tag" style={{ background: "var(--fail)" }}>
                  {t("runs.deleteDialog.tag")}
                </span>
                <span className="rid">{delTarget}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
                {t("runs.deleteDialog.description")}
              </div>
            </div>
            <footer>
              <button type="button" className="btn ghost" onClick={() => setDelTarget(null)}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={deleting} onClick={confirmDelete}>
                <Ico>
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />
                </Ico>
                {t("runs.deleteDialog.confirm")}
              </button>
            </footer>
          </div>
        </div>
      )}

      {resumeTarget && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setResumeTarget(null);
          }}
        >
          <div className="modal" style={{ width: "min(460px, 100%)" }}>
            <header>
              <div className="mi" style={{ background: "var(--pine-soft)", color: "var(--pine)" }}>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <path d="M5 3.5v9l7-4.5z" />
                </svg>
              </div>
              <div>
                <h3>{t("runs.resumeDialog.title")}</h3>
                <p>{t("runs.resumeDialog.subtitle")}</p>
              </div>
              <button type="button" className="btn ghost sm x" onClick={() => setResumeTarget(null)}>
                ✕
              </button>
            </header>
            <div className="mbody">
              <div className="testrow" style={{ background: "var(--pine-soft)", borderColor: "var(--pine)" }}>
                <span className="tag" style={{ background: "var(--pine)" }}>
                  {t("runs.resumeDialog.tag")}
                </span>
                <span className="rid">{resumeTarget}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
                {t("runs.resumeDialog.description")}
              </div>
              <div className="baselbl" style={{ marginTop: 16 }}>
                {t("runs.resumeDialog.concurrency")}
              </div>
              <InputNumber
                min={1}
                value={resumeConc ?? undefined}
                onChange={(v) => setResumeConc(typeof v === "number" ? v : null)}
                style={{ width: 120 }}
              />
            </div>
            <footer>
              <button type="button" className="btn ghost" onClick={() => setResumeTarget(null)}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="btn primary" disabled={resuming} onClick={confirmResume}>
                <Ico>
                  <path d="M5 3.5v9l7-4.5z" />
                </Ico>
                {t("runs.resumeDialog.confirm")}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
