import { useEffect, useMemo, useState } from "react";
import { App as AntdApp, AutoComplete, InputNumber, Modal, Radio } from "antd";
import { useTranslation } from "react-i18next";
import { api, PiModelInfo, RunProgress } from "../api";
import { useRuntimeMismatchConfirm } from "../useRuntimeMismatchConfirm";
import Ico, { CaptchaIco } from "./Ico";

interface Props {
  runId: string | null;
  onBack: () => void;
}

type Filter = "all" | "active" | "done" | "fail" | "captcha";

const PILL = ["running", "done", "fail", "error", "skip", "stopped", "queued", "captcha"];
function pillClass(s: string): string {
  return PILL.includes(s) ? s : "queued";
}

const FILTER_MATCH: Record<Filter, (status: string) => boolean> = {
  all: () => true,
  active: (s) => s === "running",
  done: (s) => s === "done",
  // "captcha" stays out of fail: it is a separate terminal outcome with its own tab,
  // and folding it into failures is what this feature exists to avoid.
  fail: (s) => ["fail", "error"].includes(s),
  captcha: (s) => s === "captcha",
};

// Format task elapsed time as Xm YYs, using seconds below one minute.
function fmtClock(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

// Run-scoped progress dashboard.
export default function ProgressDashboard({ runId, onBack }: Props) {
  const { message, modal } = AntdApp.useApp();
  const { t } = useTranslation();
  const confirmRuntimeMismatch = useRuntimeMismatchConfirm();
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  // Surface a retry after configuration-load failures instead of an
  // eternal "loading…" when the static config fetch lost a race (server restart / mid-write).
  const [cfgErr, setCfgErr] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // run_id is pre-generated, so this is the id used for polling and links.
  // this just tracks the run currently being viewed (re-synced when the prop changes).
  const [liveId, setLiveId] = useState<string | null>(runId);
  const [snapping, setSnapping] = useState<string | null>(null);
  // Reset the selective-rerun task list when the viewed run changes.
  const [selected, setSelected] = useState<string[]>([]);
  // bump to restart polling after a rerun re-spawns the same run_id (status → running).
  const [reloadKey, setReloadKey] = useState(0);
  // Use the run provider's Pi models for derived reruns. Empty lists allow free input.
  const [models, setModels] = useState<PiModelInfo[]>([]);
  // Batch-rerun modal target and shared configuration
  // overwrite-or-new / agent model). Re-judge has its own equivalent on the Judge view.
  const [act, setAct] = useState<
    | { target: "errors" | "selected"; taskIds: string[] | null; count: number }
    | null
  >(null);
  const [actSubmitting, setActSubmitting] = useState(false);
  const [cfgNewRun, setCfgNewRun] = useState(false);
  const [cfgConc, setCfgConc] = useState<number | null>(null);
  const [cfgModel, setCfgModel] = useState("");

  useEffect(() => {
    setLiveId(runId);
    setSelected([]);
  }, [runId]);

  useEffect(() => {
    api
      .piModels()
      .then((r) => setModels(r.models || []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!liveId) {
      setProgress(null);
      setCfg(null);
      setCfgErr(false);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    // Run config is a static per-run file, but run_eval writes run_metadata.json after the
    // WebUI has already returned the pre-generated run_id. A running run can therefore 404
    // here legitimately: keep retrying without surfacing an error until progress reaches a
    // terminal state. Once terminal, retain the bounded retry for genuine missing/corrupt
    // metadata. cfgDone gates both the retry and the poll-stop.
    let cfgDone = false;
    let cfgInFlight = false;
    let runTerminal = false;
    let terminalCfgTries = 0;
    setCfgErr(false);
    const loadCfg = () => {
      if (cfgDone || cfgInFlight || stopped) return;
      cfgInFlight = true;
      api
        .runConfig(liveId)
        .then((c) => {
          if (stopped) return;
          cfgDone = true;
          setCfgErr(false);
          setCfg(c);
        })
        .catch(() => {
          if (!stopped && runTerminal) {
            terminalCfgTries += 1;
            if (terminalCfgTries >= 3) {
              cfgDone = true;
              setCfgErr(true);
            }
          }
        })
        .finally(() => {
          cfgInFlight = false;
        });
    };
    const poll = () =>
      api
        .progress(liveId)
        .then((p) => {
          if (stopped) return;
          setProgress(p);
          runTerminal = p.status !== "running";
          // Terminal run (done/error/stopped): products on disk are static —
          // stop the two-second poll; re-entering the view fetches once. A
          // judge-only re-judge runs on a completed run, so keep polling while it is in
          // flight — gate on the authoritative `p.judging` (is_judging), NOT judge.status
          // (null on a never-judged run, which would stop the poll and strand Stop). Also
          // hold the poll open until run config resolves, so its retry track keeps ticking.
          if (p.status !== "running" && !p.judging && cfgDone) stopPolling();
        })
        .catch(() => undefined);
    const tick = () => {
      poll();
      loadCfg();
    };
    tick();
    timer = setInterval(tick, 2000);
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [liveId, reloadKey]);

  const statusLabels: Record<string, string> = {
    running: t("progress.states.running"),
    done: t("progress.states.done"),
    fail: t("progress.states.fail"),
    error: t("progress.states.error"),
    skip: t("progress.states.skip"),
    stopped: t("progress.states.stopped"),
    queued: t("progress.states.queued"),
    captcha: t("progress.states.captcha"),
  };
  const statusText = (value: string): string => statusLabels[value] ?? value;

  if (!liveId) {
    return (
      <>
        <div className="topbar">
          <div className="crumb">
            <h1>{t("progress.title")}</h1>
            <span className="sub">{t("progress.noSelection.subtitle")}</span>
          </div>
        </div>
        <div className="view">
          <div
            style={{
              maxWidth: 420,
              margin: "60px auto",
              textAlign: "center",
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-lg)",
              padding: "34px 24px",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div style={{ fontFamily: "var(--disp)", fontSize: 15, marginBottom: 6 }}>
              {t("progress.noSelection.title")}
            </div>
            <p style={{ color: "var(--ink-3)", fontSize: 12.5, margin: "0 0 16px" }}>
              {t("progress.noSelection.description")}
            </p>
            <button type="button" className="btn primary" onClick={onBack} style={{ margin: "0 auto" }}>
              {t("progress.noSelection.action")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const status = progress?.status ?? "…";
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const fail = progress?.fail ?? 0;
  const skip = progress?.skip ?? 0;
  const activeN = progress?.active ?? 0;
  // CAPTCHA-blocked tasks are resolved — they just resolved without a verdict. Counting
  // them keeps a run that hit walls from stalling below 100%.
  const captchaN = progress?.captcha ?? 0;
  const resolved = done + fail + skip + captchaN;
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;

  // ring: r=46 → circumference ≈ 289 (CSS rotates -90deg so 0 starts at top).
  const C = 2 * Math.PI * 46;
  const doneOff = total > 0 ? C * (1 - done / total) : C;
  const failLen = total > 0 ? C * (fail / total) : 0;
  const failOff = total > 0 ? -(C * (done / total)) : 0;
  const captchaLen = total > 0 ? C * (captchaN / total) : 0;
  const captchaOff = total > 0 ? -(C * ((done + fail) / total)) : 0;

  // segment width as a % of a denominator (0 when the denominator is empty).
  const segWidth = (n: number, denom: number) => (denom > 0 ? `${(n / denom) * 100}%` : "0%");
  const w = (n: number) => segWidth(n, total);

  const tasks = progress?.tasks ?? [];
  // The captcha tab only exists while the run has such tasks; fall back to all so
  // switching to a wall-free run can't strand the list on an empty filter.
  const activeFilter: Filter = filter === "captcha" && captchaN === 0 ? "all" : filter;
  const filtered = tasks.filter((t) => FILTER_MATCH[activeFilter](t.status));

  // Judge-only re-judge liveness comes from a separate stoppable subprocess in
  // flight on this (terminal) run. Progress no longer shows judge CONTENT (moved to the Judge
  // view, but still reads this to disable rerun and resume while a re-judge runs
  // backend 409s), and to keep polling so the run goes static only once judging also ends.
  const rejudging = progress?.judging ?? false;
  // During export, Stage A is done while run_eval still renders session HTML.
  // reads "exporting" rather than a bare "running" for that window.
  const exporting = progress?.exporting ?? false;
  // A cancelled run stopped mid-flight and enables resume. Read from
  // the backend flag (run_metadata.cancelled), robust to the "stopped" pill being lost after
  // a WebUI restart.
  const cancelled = progress?.cancelled ?? false;
  const agentProvider = cfg?.run?.provider === "codex" ? "codex" : "pi";
  const agentCfg = cfg?.providers?.[agentProvider];
  const agentModel = agentCfg?.model;

  const doStop = async () => {
    try {
      await api.stopRun(liveId);
      message.info(t("progress.feedback.stopSignalled", { runId: liveId }));
    } catch (e) {
      message.error(String(e));
    }
  };

  // Render a live provider-conversation snapshot on demand and
  // open it in a new tab; the backend queues concurrent clicks per task.
  const doSnapshot = async (taskId: string) => {
    setSnapping(taskId);
    try {
      const { url } = await api.sessionSnapshot(liveId, taskId);
      window.open(url, "_blank", "noreferrer");
    } catch (e) {
      message.error(String(e));
    } finally {
      setSnapping(null);
    }
  };

  const toggleSel = (id: string, on: boolean) =>
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  // Agent-model candidates for a derived rerun come from the run's frozen
  // provider's models, mirroring ConfigForm. Free input allowed; empty list → free input only.
  const rerunModelOptions = useMemo(() => {
    if (agentProvider !== "pi") return [];
    const prov = agentCfg?.provider;
    return models.filter((m) => !prov || m.provider === prov).map((m) => ({ value: m.model }));
  }, [models, agentProvider, agentCfg]);

  // Prefill the batch-rerun modal from the
  // run's frozen config — run concurrency + agent model, overwrite by default.
  const openActionCfg = (target: "errors" | "selected", taskIds: string[] | null, count: number) => {
    setAct({ target, taskIds, count });
    setCfgNewRun(false);
    setCfgConc(cfg?.run?.concurrency ?? null);
    setCfgModel(agentModel ?? "");
  };

  // Batch rerun overwrites the same run id or creates a derived run id,
  // which the Progress view then follows. Model is sent only when deriving (frozen on overwrite).
  const submitActionCfg = async () => {
    if (!liveId || !act) return;
    const body: {
      task_ids?: string[];
      errors?: boolean;
      concurrency?: number;
      model?: string;
      new_run: boolean;
    } = { new_run: cfgNewRun };
    if (act.target === "errors") body.errors = true;
    else body.task_ids = act.taskIds ?? [];
    if (cfgConc != null) body.concurrency = cfgConc;
    if (cfgNewRun && cfgModel.trim()) body.model = cfgModel.trim();
    setActSubmitting(true);
    try {
      const started = await confirmRuntimeMismatch((allow) =>
        api.rerun(liveId, { ...body, allow_runtime_mismatch: allow }),
      );
      if (!started) return; // the runtime question was declined; nothing was launched
      const { run_id } = started;
      message.success(
        cfgNewRun
          ? t("progress.feedback.derivedStarted", { runId: run_id })
          : t("progress.feedback.rerunStarted", { runId: liveId }),
      );
      setSelected([]);
      setAct(null);
      if (run_id !== liveId) setLiveId(run_id); // Follow the derived run.
      setReloadKey((k) => k + 1);
    } catch (e) {
      message.error(String(e));
    } finally {
      setActSubmitting(false);
    }
  };

  // Shared rerun configuration includes destination, concurrency, and agent model. Model
  // is editable ONLY when deriving a new run (overwrite freezes it).
  const cfgBlock = () => (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12 }}>
      <Radio.Group
        value={cfgNewRun ? "new" : "overwrite"}
        onChange={(e) => setCfgNewRun(e.target.value === "new")}
        style={{ marginBottom: 12 }}
      >
        <Radio value="overwrite">{t("progress.rerunDialog.overwrite")}</Radio>
        <Radio value="new">{t("progress.rerunDialog.create")}</Radio>
      </Radio.Group>
      <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <span style={{ marginRight: 8, fontSize: 12, color: "var(--ink-3)" }}>
            {t("progress.rerunDialog.concurrency")}
          </span>
          <InputNumber
            min={1}
            value={cfgConc ?? undefined}
            onChange={(v) => setCfgConc(typeof v === "number" ? v : null)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span style={{ marginRight: 8, fontSize: 12, color: "var(--ink-3)" }}>
            {t("progress.rerunDialog.agentModel")}
          </span>
          {cfgNewRun ? (
            <AutoComplete
              value={cfgModel}
              onChange={setCfgModel}
              options={rerunModelOptions}
              filterOption={(input, opt) =>
                String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())
              }
              style={{ minWidth: 220 }}
              placeholder={t("progress.rerunDialog.modelPlaceholder")}
            />
          ) : (
            <span
              style={{ fontSize: 12.5, color: "var(--ink-2)" }}
              title={t("progress.rerunDialog.frozenTitle")}
            >
              {agentModel ?? "—"}{" "}
              <i style={{ color: "var(--ink-3)" }}>{t("progress.rerunDialog.frozen")}</i>
            </span>
          )}
        </div>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "10px 0 0" }}>
        {cfgNewRun
          ? t("progress.rerunDialog.deriveDescription", { runId: liveId })
          : t("progress.rerunDialog.overwriteDescription", { runId: liveId })}
      </p>
    </div>
  );

  // Resume unfinished tasks in place with
  // the frozen config; the only editable knob is concurrency (prefilled with the original).
  const doResume = () => {
    if (!liveId) return;
    let conc: number | null = cfg?.run?.concurrency ?? null;
    modal.confirm({
      title: t("progress.resumeDialog.title"),
      content: (
        <div>
          <p style={{ marginBottom: 10 }}>
            {t("progress.resumeDialog.description", { runId: liveId })}
          </p>
          <span style={{ marginRight: 8 }}>{t("progress.resumeDialog.concurrency")}</span>
          <InputNumber
            min={1}
            defaultValue={conc ?? undefined}
            onChange={(v) => {
              conc = typeof v === "number" ? v : null;
            }}
          />
        </div>
      ),
      okText: t("progress.resumeDialog.confirm"),
      cancelText: t("common.actions.cancel"),
      onOk: async () => {
        try {
          const started = await confirmRuntimeMismatch((allow) =>
            api.resume(liveId, {
              ...(conc != null ? { concurrency: conc } : {}),
              allow_runtime_mismatch: allow,
            }),
          );
          if (!started) return; // declined: leave the dialog's own decision to the user
          message.success(t("progress.feedback.resumeStarted", { runId: liveId }));
          setReloadKey((k) => k + 1); // restart polling so the resumed run goes live again
        } catch (e) {
          message.error(String(e));
          throw e; // keep the dialog open on failure
        }
      },
    });
  };

  const cfgRows: [string, any][] = cfg
    ? [
        [t("progress.config.benchmark"), cfg.run?.benchmark],
        [t("progress.config.browserTool"), cfg.run?.browser_tool],
        [t("progress.config.guard"), cfg.run?.browser_tool_mode],
        [t("progress.config.concurrency"), cfg.run?.concurrency],
        [t("progress.config.agentProvider"), agentProvider],
        [t("progress.config.modelProvider"), agentProvider === "pi" ? agentCfg?.provider : "openai"],
        [t("progress.config.model"), agentModel],
        // Judge model and mode live in the Judge view's configuration panel.
        // Show only the limit selected by mode.
        cfg.limits?.mode === "steps"
          ? [t("progress.config.maxTurns"), cfg.limits?.max_turns]
          : [t("progress.config.timeout"), cfg.limits?.task_timeout_seconds],
      ]
    : [];

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <h1>{t("progress.title")}</h1>
          <span className="sub">
            {liveId} · {statusText(status)}
          </span>
        </div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={onBack}>
            {t("progress.actions.back")}
          </button>
          {status !== "running" && cancelled && !rejudging && (
            <button
              type="button"
              className="btn primary"
              onClick={doResume}
              title={t("progress.actions.resumeTitle")}
            >
              <Ico>
                <path d="M5 3.5v9l7-4.5z" />
              </Ico>
              {t("progress.actions.resume")}
            </button>
          )}
          {status !== "running" && fail > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => openActionCfg("errors", null, fail)}
              disabled={rejudging}
              title={
                rejudging
                  ? t("progress.actions.waitRejudge")
                  : t("progress.actions.rerunErrorsTitle")
              }
            >
              <Ico>
                <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
              </Ico>
              {t("progress.actions.rerunErrors", { count: fail })}
            </button>
          )}
          {/* Separate from "rerun errors": these tasks did not fail, they were refused.
              Worth its own entry point because a wall often clears on a later attempt,
              and resume skips them (they carry no error, so they count as done). */}
          {status !== "running" && captchaN > 0 && (
            <button
              type="button"
              className="btn captcha"
              onClick={() =>
                openActionCfg(
                  "selected",
                  tasks.filter((t) => t.status === "captcha").map((t) => t.task_id),
                  captchaN,
                )
              }
              disabled={rejudging}
              title={
                rejudging
                  ? t("progress.actions.waitRejudge")
                  : t("progress.actions.rerunCaptchaTitle")
              }
            >
              <CaptchaIco w={14} />
              {t("progress.actions.rerunCaptcha", { count: captchaN })}
            </button>
          )}
          {status !== "running" && selected.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => openActionCfg("selected", selected, selected.length)}
              disabled={rejudging}
              title={
                rejudging
                  ? t("progress.actions.waitRejudge")
                  : t("progress.actions.rerunSelectedTitle")
              }
            >
              <Ico>
                <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
              </Ico>
              {t("progress.actions.rerunSelected", { count: selected.length })}
            </button>
          )}
          {/* Stage-A stop only; judge-only work is stopped from the Judge view,
              which owns judge lifecycle now. Same /stop endpoint, scoped to the live Stage A. */}
          {status === "running" && (
            <button type="button" className="btn danger" onClick={doStop}>
              <Ico>
                <rect x="4" y="4" width="8" height="8" rx="1.4" />
              </Ico>
              {t("progress.actions.stop")}
            </button>
          )}
        </div>
      </div>

      <div className="view">
        <div className="prog-layout">
          {/* LEFT: ring + counts + config */}
          <div className="prog-side">
            <div className="prog-hero">
              <div className="top">
                <span className="rid2">{liveId}</span>
                <span className={`pill ${exporting ? "exporting" : pillClass(status)}`}>
                  <span className="dot" />
                  {exporting ? t("progress.states.exporting") : statusText(status)}
                </span>
              </div>

              <div className="ring-wrap">
                <div className="ring">
                  <svg width="108" height="108" viewBox="0 0 108 108">
                    <circle cx="54" cy="54" r="46" fill="none" stroke="var(--paper-2)" strokeWidth="11" />
                    <circle
                      cx="54"
                      cy="54"
                      r="46"
                      fill="none"
                      stroke="var(--done)"
                      strokeWidth="11"
                      strokeLinecap="round"
                      strokeDasharray={C}
                      strokeDashoffset={doneOff}
                    />
                    <circle
                      cx="54"
                      cy="54"
                      r="46"
                      fill="none"
                      stroke="var(--fail)"
                      strokeWidth="11"
                      strokeLinecap="butt"
                      strokeDasharray={`${failLen} ${C - failLen}`}
                      strokeDashoffset={failOff}
                    />
                    <circle
                      cx="54"
                      cy="54"
                      r="46"
                      fill="none"
                      stroke="var(--amber)"
                      strokeWidth="11"
                      strokeLinecap="butt"
                      strokeDasharray={`${captchaLen} ${C - captchaLen}`}
                      strokeDashoffset={captchaOff}
                    />
                  </svg>
                  <div className="label">
                    <b>{pct}%</b>
                    <span>{t("progress.metrics.complete")}</span>
                  </div>
                </div>
                <div className="ring-legend">
                  <div className="li">
                    <span className="sw" style={{ background: "var(--done)" }} />
                    <span className="lbl">{t("progress.metrics.done")}</span>
                    <span className="n">{done}</span>
                  </div>
                  <div className="li">
                    <span className="sw" style={{ background: "var(--fail)" }} />
                    <span className="lbl">{t("progress.metrics.fail")}</span>
                    <span className="n">{fail}</span>
                  </div>
                  {captchaN > 0 && (
                    <div className="li">
                      <span className="sw" style={{ background: "var(--amber)" }} />
                      <span className="lbl">{t("progress.metrics.captcha")}</span>
                      <span className="n">{captchaN}</span>
                    </div>
                  )}
                  <div className="li">
                    <span className="sw" style={{ background: "var(--skip)" }} />
                    <span className="lbl">{t("progress.metrics.skip")}</span>
                    <span className="n">{skip}</span>
                  </div>
                  <div className="li">
                    <span className="sw" style={{ background: "var(--run)" }} />
                    <span className="lbl">{t("progress.metrics.active")}</span>
                    <span className="n">{activeN}</span>
                  </div>
                </div>
              </div>

              <div className="linbar-wrap">
                <div className="top">
                  <span>{t("progress.metrics.progress")}</span>
                  <span>{t("progress.metrics.resolved", { resolved, total })}</span>
                </div>
                <div className="linbar">
                  {total > 0 && <i className="d" style={{ width: w(done) }} />}
                  {total > 0 && <i className="f" style={{ width: w(fail) }} />}
                  {total > 0 && <i className="e" style={{ width: w(captchaN) }} />}
                  {total > 0 && <i className="s" style={{ width: w(skip) }} />}
                  {total > 0 && <i className="a" style={{ width: w(activeN) }} />}
                </div>
              </div>

              <div className="counts" style={{ marginTop: 16 }}>
                <div className="c total">
                  <b>{total}</b>
                  <span>{t("progress.metrics.total")}</span>
                </div>
                <div className="c done">
                  <b>{done}</b>
                  <span>{t("progress.metrics.done")}</span>
                </div>
                <div className="c fail">
                  <b>{fail}</b>
                  <span>{t("progress.metrics.fail")}</span>
                </div>
                {captchaN > 0 && (
                  <div className="c captcha">
                    <b>{captchaN}</b>
                    <span>{t("progress.metrics.captcha")}</span>
                  </div>
                )}
                <div className="c skip">
                  <b>{skip}</b>
                  <span>{t("progress.metrics.skip")}</span>
                </div>
                <div className="c active">
                  <b>{activeN}</b>
                  <span>{t("progress.metrics.active")}</span>
                </div>
              </div>
            </div>

            <div className="prog-config">
              <h5>{t("progress.config.title")}</h5>
              <div className="kv">
                {cfgRows.map(([k, v]) => (
                  <div className="row" key={k}>
                    <span className="k">{k}</span>
                    <span className="v">{v ?? "—"}</span>
                  </div>
                ))}
                {!cfg && !cfgErr && (
                  <div style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                    {t("progress.config.loading")}
                  </div>
                )}
                {!cfg && cfgErr && (
                  <button
                    type="button"
                    onClick={() => setReloadKey((k) => k + 1)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      font: "inherit",
                      textAlign: "left",
                      color: "var(--fail)",
                      fontSize: 11.5,
                    }}
                    title={t("progress.config.loadFailedTitle")}
                  >
                    {t("progress.config.loadFailed")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: task detail */}
          <div className="prog-main">
            <header>
              <h4>{t("progress.detail.title")}</h4>
              <div className="filtertabs">
                <button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
                  {t("progress.detail.filter", { label: t("progress.detail.all"), count: total })}
                </button>
                <button type="button" className={filter === "active" ? "on" : ""} onClick={() => setFilter("active")}>
                  {t("progress.detail.filter", {
                    label: t("progress.detail.active"),
                    count: activeN,
                  })}
                </button>
                <button type="button" className={filter === "done" ? "on" : ""} onClick={() => setFilter("done")}>
                  {t("progress.detail.filter", { label: t("progress.detail.done"), count: done })}
                </button>
                <button type="button" className={filter === "fail" ? "on" : ""} onClick={() => setFilter("fail")}>
                  {t("progress.detail.filter", { label: t("progress.detail.fail"), count: fail })}
                </button>
                {/* Only worth a tab once a run has actually hit a wall. */}
                {captchaN > 0 && (
                  <button
                    type="button"
                    className={filter === "captcha" ? "on" : ""}
                    onClick={() => setFilter("captcha")}
                  >
                    {t("progress.detail.filter", {
                      label: t("progress.detail.captcha"),
                      count: captchaN,
                    })}
                  </button>
                )}
              </div>
            </header>
            <div className="tasklist">
              <div className="trow thead">
                <span className="tchk">
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={t("progress.detail.selectAll")}
                    checked={filtered.length > 0 && filtered.every((t) => selected.includes(t.task_id))}
                    onChange={(e) => setSelected(e.target.checked ? filtered.map((t) => t.task_id) : [])}
                  />
                </span>
                <span className="tnum" />
                <div className="tid">{t("progress.detail.columns.task")}</div>
                <span className="th">{t("progress.detail.columns.status")}</span>
                <span className="th">{t("progress.detail.columns.time")}</span>
                <span className="th">{t("progress.detail.columns.turns")}</span>
                <span className="th">{t("progress.detail.columns.session")}</span>
              </div>
              {filtered.map((task, i) => {
                const running = task.status === "running";
                return (
                  <div className="trow" key={task.task_id}>
                    <span className="tchk">
                      <input
                        type="checkbox"
                        className="checkbox"
                        aria-label={t("progress.detail.selectTask", { taskId: task.task_id })}
                        checked={selected.includes(task.task_id)}
                        onChange={(e) => toggleSel(task.task_id, e.target.checked)}
                      />
                    </span>
                    <span className="tnum">{String(i + 1).padStart(2, "0")}</span>
                    <div className="tid">
                      {task.task_id}
                      {task.attempts != null && task.attempts > 1 && (
                        <span
                          className="retrytag"
                          title={t("progress.detail.retryTitle", { count: task.attempts - 1 })}
                        >
                          ↻{task.attempts - 1}
                        </span>
                      )}
                    </div>
                    <span className={`pill ${pillClass(task.status)}`}>
                      {task.status === "captcha" ? <CaptchaIco /> : <span className="dot" />}
                      {statusText(task.status)}
                    </span>
                    <span
                      className={`tdur${running ? " live" : ""}`}
                      title={
                        running ? t("progress.detail.elapsed") : t("progress.detail.duration")
                      }
                    >
                      {fmtClock(task.duration_s)}
                    </span>
                    <span className="tturns" title={t("progress.detail.sessionTurns")}>
                      {task.turns ?? "—"}
                    </span>
                    {task.has_session ? (
                      <a
                        className="openlink"
                        href={`/runs/${liveId}/sessions_html/${task.task_id}.html`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("progress.detail.open")}
                      </a>
                    ) : task.session_known ? (
                      <button
                        type="button"
                        className="openlink"
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left" }}
                        title={t("progress.detail.snapshotTitle")}
                        disabled={snapping === task.task_id}
                        onClick={() => doSnapshot(task.task_id)}
                      >
                        {snapping === task.task_id
                          ? t("progress.detail.rendering")
                          : t("progress.detail.snapshot")}
                      </button>
                    ) : (
                      <span className="openlink muted">
                        —{" "}
                        {task.status === "skip"
                          ? t("progress.detail.noSession")
                          : t("progress.detail.pending")}
                      </span>
                    )}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ padding: "26px 18px", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                  {progress ? t("progress.detail.empty") : t("progress.detail.loading")}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The batch-rerun modal combines concurrency, destination, and agent model,
          shared by Rerun errors & selected. New run derives an independent run. (Re-judge has
          its own equivalent on the Judge view.) */}
      <Modal
        open={act !== null}
        title={
          act
            ? act.target === "errors"
              ? t("progress.rerunDialog.titleErrors", { count: act.count })
              : t("progress.rerunDialog.titleSelected", { count: act.count })
            : ""
        }
        onCancel={() => setAct(null)}
        onOk={submitActionCfg}
        okText={cfgNewRun ? t("progress.rerunDialog.create") : t("progress.rerunDialog.confirm")}
        okButtonProps={{ danger: !cfgNewRun }}
        confirmLoading={actSubmitting}
        width={560}
        destroyOnClose
      >
        {act && (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 0 }}>
              {t("progress.rerunDialog.description")}
            </p>
            {cfgBlock()}
          </div>
        )}
      </Modal>
    </>
  );
}
