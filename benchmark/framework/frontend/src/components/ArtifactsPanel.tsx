import { useEffect, useMemo, useState } from "react";
import { App as AntdApp } from "antd";
import { useTranslation } from "react-i18next";
import { api, ArtifactGroup, ArtifactFile } from "../api";
import { appLocale, type AppLocale } from "../i18n";
import { formatDateTime } from "../i18n/format";
import { buildRunForest, flattenRunForest, type RunTreeNode } from "../runHierarchy";
import {
  modelFilterKey,
  resolveFilterPreference,
  useScopeFilterPreference,
} from "../useScopeFilterPreference";

// The artifact browser performs a pure on-disk scan grouped by run.
// "Open" links to the statically mounted /runs/<id>/<file>; export shortcuts reuse
// the existing export endpoints. Each group also surfaces which models
// ran it (agent + judge) and a manual, inline-editable note (runs/<id>/note.md). The
// page is organised by provider → model → dataset: three filter rows scope the view, and the
// selected provider/model runs remain grouped under per-dataset section headers.

// dataset bucket for a run; null benchmark (ad-hoc runs) folds into "ad-hoc".
function datasetKey(g: ArtifactGroup): string {
  return g.benchmark || "ad-hoc";
}

function providerKey(g: ArtifactGroup): string {
  return g.provider || "unknown";
}

// task (agent) model in provider/model form, matching the judge chip
// (e.g. "openai-codex/gpt-5.5"). Falls back to the bare model on pre-field runs.
function taskModelLabel(g: ArtifactGroup): string | null {
  if (!g.model) return null;
  const modelProvider = g.model_provider || g.pi_provider;
  const model = modelProvider ? `${modelProvider}/${g.model}` : g.model;
  return g.provider ? `${g.provider} · ${model}` : model;
}

function fmtTime(epoch: number, locale: AppLocale): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return formatDateTime(d, locale);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function ArtifactsPanel() {
  const { message } = AntdApp.useApp();
  const { t, i18n } = useTranslation();
  const locale = appLocale(i18n.resolvedLanguage);
  const [groups, setGroups] = useState<ArtifactGroup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Artifacts filters are peers: changing one preserves the other two selections.
  const { preference, selectProvider, selectModel, selectDataset } = useScopeFilterPreference(
    "artifacts",
    "independent",
  );
  // Track the open inline note, its draft, and save-in-flight state.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set());

  const load = () => {
    api
      .artifacts()
      .then(setGroups)
      .catch((e) => message.error(String(e)));
  };
  useEffect(load, []);

  // Each filter row is derived from the full artifact set. The visible cards are the
  // intersection of the three selections; endpoint order remains intact within buckets.
  const filterView = useMemo(() => {
    const providerKeys = new Set<string>();
    const modelKeys = new Set<string>();
    const datasetKeys = new Set<string>();
    const providerCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const catCounts = new Map<string, number>();
    for (const g of groups ?? []) {
      const provider = providerKey(g);
      const model = modelFilterKey(g.model);
      const dataset = datasetKey(g);
      providerKeys.add(provider);
      modelKeys.add(model);
      datasetKeys.add(dataset);
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
      catCounts.set(dataset, (catCounts.get(dataset) ?? 0) + 1);
    }

    const providerFilter = resolveFilterPreference(preference.provider, providerKeys);
    const modelFilter = resolveFilterPreference(preference.model, modelKeys);
    const cat = resolveFilterPreference(preference.dataset, datasetKeys);

    const buckets = new Map<string, ArtifactGroup[]>();
    for (const g of groups ?? []) {
      if (providerFilter !== "all" && providerKey(g) !== providerFilter) continue;
      if (modelFilter !== "all" && modelFilterKey(g.model) !== modelFilter) continue;
      const k = datasetKey(g);
      if (cat !== "all" && k !== cat) continue;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(g);
    }

    return {
      providerFilter,
      modelFilter,
      cat,
      providers: [...providerCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      models: [...modelCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      cats: [...catCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      sections: [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map<[string, RunTreeNode<ArtifactGroup>[], number]>(([dataset, runs]) => [
          dataset,
          buildRunForest(runs),
          runs.length,
        ]),
    };
  }, [groups, preference.provider, preference.model, preference.dataset]);

  const toggleChildren = (id: string) =>
    setExpandedRuns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exportZip = async (kind: "report" | "sessions", runId: string) => {
    setBusy(`${kind}:${runId}`);
    try {
      const r =
        kind === "report"
          ? await api.exportSingle([runId], { locale })
          : await api.exportSessions([runId]);
      message.success(t("artifacts.feedback.exported", { path: r.path }), 6);
      load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  // Build report HTML in-place (no zip) → shows up as a REPORT row with an open link.
  const buildReport = async (runId: string) => {
    setBusy(`build:${runId}`);
    try {
      await api.buildReport([runId], { locale });
      message.success(t("artifacts.feedback.reportGenerated"), 4);
      load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(`delete:${deleteTarget}`);
    try {
      await api.deleteRun(deleteTarget);
      setGroups((current) => (current ?? []).filter((group) => group.run_id !== deleteTarget));
      if (editing === deleteTarget) setEditing(null);
      message.success(t("artifacts.feedback.deleted", { runId: deleteTarget }));
      setDeleteTarget(null);
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (g: ArtifactGroup) => {
    setEditing(g.run_id);
    setDraft(g.note ?? "");
  };

  const saveNote = async (runId: string) => {
    setSavingNote(true);
    try {
      const { note } = await api.putNote(runId, draft);
      // patch the group's note in place so the panel reflects the save without a full reload.
      setGroups((gs) => (gs ?? []).map((g) => (g.run_id === runId ? { ...g, note } : g)));
      setEditing(null);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSavingNote(false);
    }
  };

  const fileRow = (runId: string, f: ArtifactFile) => (
    <div className="art-row" key={f.name}>
      <span className="art-kind report">{t("artifacts.labels.report")}</span>
      <span className="art-name">{f.name}</span>
      <span className="art-meta">{fmtSize(f.size)}</span>
      <span className="art-meta">{fmtTime(f.mtime, locale)}</span>
      <a className="openlink" href={`/runs/${runId}/${f.name}`} target="_blank" rel="noreferrer">
        {t("common.actions.open")}
      </a>
    </div>
  );

  // Render the note editor immediately after the latest timestamp.
  const noteBlock = (g: ArtifactGroup) => {
    if (editing === g.run_id) {
      return (
        <span className="art-note editing">
          <textarea
            className="art-note-input"
            value={draft}
            autoFocus
            placeholder={t("artifacts.note.placeholder")}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn sm"
            disabled={savingNote}
            onClick={() => saveNote(g.run_id)}
          >
            {savingNote ? t("artifacts.actions.saving") : t("artifacts.actions.save")}
          </button>
          <button type="button" className="btn sm ghost" disabled={savingNote} onClick={() => setEditing(null)}>
            {t("common.actions.cancel")}
          </button>
        </span>
      );
    }
    return g.note ? (
      <button
        type="button"
        className="art-note has"
        title={t("artifacts.actions.editNote")}
        onClick={() => startEdit(g)}
      >
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M9 2.5l2.5 2.5M2 12l1-3 6.5-6.5 2.5 2.5L5.5 11.5z" />
        </svg>
        <span className="txt">{g.note}</span>
      </button>
    ) : (
      <button
        type="button"
        className="art-note add"
        title={t("artifacts.actions.addNote")}
        onClick={() => startEdit(g)}
      >
        + {t("artifacts.actions.addNote")}
      </button>
    );
  };

  const groupCard = (g: ArtifactGroup, depth: number, childCount: number) => {
    const taskModel = taskModelLabel(g);
    const expanded = expandedRuns.has(g.run_id);
    return (
      <div
        className={`art-group art-tree-item ${depth > 0 ? "derived" : ""}`}
        style={{ marginLeft: depth * 24 }}
        key={g.run_id}
      >
        <header>
          <div className="t">
            <div className="t-top">
              {childCount > 0 ? (
                <button
                  type="button"
                  className="tree-toggle"
                  aria-expanded={expanded}
                  aria-label={t("runs.tree.toggle", {
                    action: expanded ? t("runs.tree.collapse") : t("runs.tree.expand"),
                    count: childCount,
                  })}
                  onClick={() => toggleChildren(g.run_id)}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d={expanded ? "M3.5 5.5L8 10l4.5-4.5" : "M5.5 3.5L10 8l-4.5 4.5"} />
                  </svg>
                </button>
              ) : depth > 0 ? (
                <span className="tree-branch">↳</span>
              ) : null}
              <b>{g.run_id}</b>
              {g.derived_from && (
                <span
                  className="derived-chip"
                  title={t("runs.tree.derivedFrom", { runId: g.derived_from })}
                >
                  {t("runs.tree.rejudge")}
                </span>
              )}
              {childCount > 0 && (
                <span className="run-child-count">
                  {t("runs.tree.children", { count: childCount })}
                </span>
              )}
              <span className="latest">
                {t("artifacts.labels.latest", { time: fmtTime(g.latest_mtime, locale) })}
              </span>
              {noteBlock(g)}
            </div>
            {(taskModel || g.judge_model) && (
              <div className="art-models">
                {taskModel && (
                  <span className="art-model" title={t("artifacts.models.taskTitle")}>
                    <i>{t("artifacts.labels.task")}</i>
                    {taskModel}
                  </span>
                )}
                {g.judge_model && (
                  <span className="art-model judge" title={t("artifacts.models.judgeTitle")}>
                    <i>{t("artifacts.labels.judge")}</i>
                    {g.judge_model}
                    {g.judge_mode ? ` · ${g.judge_mode}` : ""}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="ops">
            <button
              type="button"
              className="btn sm"
              disabled={busy !== null}
              onClick={() => buildReport(g.run_id)}
            >
              {busy === `build:${g.run_id}`
                ? t("artifacts.actions.building")
                : t("artifacts.actions.buildReport")}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy !== null}
              onClick={() => exportZip("report", g.run_id)}
            >
              {busy === `report:${g.run_id}`
                ? t("artifacts.actions.exporting")
                : t("artifacts.actions.buildReportZip")}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy !== null}
              onClick={() => exportZip("sessions", g.run_id)}
            >
              {busy === `sessions:${g.run_id}`
                ? t("artifacts.actions.exporting")
                : t("artifacts.actions.sessionsZip")}
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy !== null}
              onClick={() => setDeleteTarget(g.run_id)}
            >
              {t("artifacts.actions.delete")}
            </button>
          </div>
        </header>
        <div className="art-rows">
          {g.reports.map((f) => fileRow(g.run_id, f))}
          {g.sessions_count > 0 && (
            <div className="art-row">
              <span className="art-kind sessions">{t("artifacts.labels.sessions")}</span>
              <span className="art-name">
                {t("artifacts.labels.pages", { count: g.sessions_count })}
              </span>
              <span className="art-meta" />
              <span className="art-meta">{t("artifacts.sessionsDescription")}</span>
              <span />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <h1>{t("artifacts.title")}</h1>
          <span className="sub">{t("artifacts.subtitle")}</span>
        </div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={load}>
            {t("artifacts.actions.refresh")}
          </button>
        </div>
      </div>

      <div className="view">
        {groups !== null && groups.length > 0 && (
          <div className="scopefilters" role="group" aria-label={t("artifacts.filters.label")}>
            <div className="scopefilter-row provider-row">
              <span className="scopefilter-label">{t("artifacts.filters.provider")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.providerFilter === "all" ? "on" : ""}
                  onClick={() => selectProvider("all")}
                >
                  {t("artifacts.filters.all", { count: groups.length })}
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
              <span className="scopefilter-label">{t("artifacts.filters.model")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.modelFilter === "all" ? "on" : ""}
                  onClick={() => selectModel(filterView.providerFilter, "all")}
                >
                  {t("artifacts.filters.all", { count: groups.length })}
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
              <span className="scopefilter-label">{t("artifacts.filters.dataset")}</span>
              <div className="filtertabs">
                <button
                  type="button"
                  className={filterView.cat === "all" ? "on" : ""}
                  onClick={() => selectDataset(filterView.providerFilter, filterView.modelFilter, "all")}
                >
                  {t("artifacts.filters.all", { count: groups.length })}
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

        {groups === null && (
          <div style={{ color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
            {t("artifacts.empty.loading")}
          </div>
        )}
        {groups !== null && groups.length === 0 && (
          <div className="art-empty">{t("artifacts.empty.none")}</div>
        )}
        {groups !== null && groups.length > 0 && filterView.sections.length === 0 && (
          <div className="art-empty">{t("artifacts.empty.filtered")}</div>
        )}
        {filterView.sections.map(([dataset, forest, count]) => {
          const rows = flattenRunForest(forest, expandedRuns);
          return (
            <section className="art-section" key={dataset}>
              <div className="art-section-head">
                <span className="ds">{dataset}</span>
                <span className="n">{t("artifacts.labels.runs", { count })}</span>
              </div>
              {rows.map(({ item, depth, childCount }) => groupCard(item, depth, childCount))}
            </section>
          );
        })}
      </div>

      {deleteTarget && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && busy === null) setDeleteTarget(null);
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
                <h3>{t("artifacts.deleteDialog.title")}</h3>
                <p>{t("artifacts.deleteDialog.subtitle")}</p>
              </div>
              <button
                type="button"
                className="btn ghost sm x"
                disabled={busy !== null}
                onClick={() => setDeleteTarget(null)}
              >
                ✕
              </button>
            </header>
            <div className="mbody">
              <div className="testrow" style={{ background: "var(--fail-soft)", borderColor: "var(--fail)" }}>
                <span className="tag" style={{ background: "var(--fail)" }}>
                  {t("artifacts.deleteDialog.tag")}
                </span>
                <span className="rid">{deleteTarget}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
                {t("artifacts.deleteDialog.description")}
              </div>
            </div>
            <footer>
              <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setDeleteTarget(null)}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={busy !== null} onClick={confirmDelete}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />
                </svg>
                {busy === `delete:${deleteTarget}`
                  ? t("artifacts.deleteDialog.deleting")
                  : t("artifacts.deleteDialog.confirm")}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
