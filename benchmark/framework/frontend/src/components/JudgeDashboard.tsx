import { useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  AutoComplete,
  Checkbox,
  InputNumber,
  Modal,
  Radio,
  Select,
  Spin,
  Tag,
} from "antd";
import { useTranslation } from "react-i18next";
import { api, JudgeProgress, PiModelInfo, TaskJudge } from "../api";
import Ico, { CaptchaIco } from "./Ico";

interface Props {
  runId: string | null;
  onBack: () => void;
}

type Filter = "all" | "pass" | "fail" | "err" | "pending" | "captcha";

const FILTER_MATCH: Record<Filter, (s: string) => boolean> = {
  all: () => true,
  pass: (s) => s === "pass",
  fail: (s) => s === "fail",
  err: (s) => s === "err",
  pending: (s) => s === "pending",
  captcha: (s) => s === "captcha",
};

// Verdict colors: pass=green, fail=red, err=amber, captcha=amber, pending=neutral.
function jPillClass(s: string): string {
  return s === "pass"
    ? "done"
    : s === "fail"
      ? "fail"
      : s === "err"
        ? "err"
        : s === "captcha"
          ? "captcha"
          : "queued";
}

// Format judge wall time as Xm YYs, using seconds below one minute.
function fmtClock(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function fmtCost(c: number | null | undefined): string {
  return c == null ? "—" : `$${c.toFixed(2)}`;
}

// Re-judge cart: task_id maps to a whole task or a rubric-id subset. Pure frontend
// state — selection stays usable while a re-judge runs; only submission is gated.
type Cart = Record<string, string[] | null>;

// Run-scoped judge dashboard with judge content instead of Stage A content.
export default function JudgeDashboard({ runId, onBack }: Props) {
  const { message } = AntdApp.useApp();
  const { t: tr } = useTranslation();
  const [jp, setJp] = useState<JudgeProgress | null>(null);
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [cfgErr, setCfgErr] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [liveId, setLiveId] = useState<string | null>(runId);
  const [cart, setCart] = useState<Cart>({});
  const [reloadKey, setReloadKey] = useState(0);
  // Pi judge models for the re-judge dropdown.
  const [models, setModels] = useState<PiModelInfo[]>([]);

  // Per-row rubric picker feeds the cart without executing a request.
  const [rjTask, setRjTask] = useState<string | null>(null);
  const [rjData, setRjData] = useState<TaskJudge | null>(null);
  const [rjLoading, setRjLoading] = useState(false);
  const [rjErr, setRjErr] = useState<string | null>(null);
  const [rjPicked, setRjPicked] = useState<string[]>([]);
  // Re-judge configuration modal shared by error and cart targets.
  const [act, setAct] = useState<{ target: "errors" | "cart"; count: number } | null>(null);
  const [actSubmitting, setActSubmitting] = useState(false);
  const [cfgNewRun, setCfgNewRun] = useState(false);
  const [cfgConc, setCfgConc] = useState<number | null>(null);
  const [cfgModel, setCfgModel] = useState("");
  const [cfgMode, setCfgMode] = useState("");

  useEffect(() => {
    setLiveId(runId);
    setCart({});
  }, [runId]);

  useEffect(() => {
    api
      .piModels()
      .then((r) => setModels(r.models || []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!liveId) {
      setJp(null);
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
    // Retry run configuration on each tick so a single fetch race
    // losing a race would otherwise strand the config panel on "loading…" forever.
    let cfgDone = false;
    let cfgInFlight = false;
    let cfgTries = 0;
    setCfgErr(false);
    const loadCfg = () => {
      if (cfgDone || cfgInFlight || stopped) return;
      cfgInFlight = true;
      cfgTries += 1;
      api
        .runConfig(liveId)
        .then((c) => {
          if (stopped) return;
          cfgDone = true;
          setCfgErr(false);
          setCfg(c);
        })
        .catch(() => {
          if (!stopped && cfgTries >= 3) {
            cfgDone = true;
            setCfgErr(true);
          }
        })
        .finally(() => {
          cfgInFlight = false;
        });
    };
    const poll = () =>
      api
        .judgeProgress(liveId)
        .then((p) => {
          if (stopped) return;
          setJp(p);
          // keep polling while Stage A runs OR a judge subprocess is live (auto-judge or a
          // judge-only re-judge) — gate on judging, not judge.status, so the "no judge
          // file yet" re-judge window keeps ticking. Stop once everything is terminal.
          const judging = p.judging || p.judge?.status === "running";
          if (p.status !== "running" && !judging && cfgDone) stopPolling();
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

  if (!liveId) {
    return (
      <>
        <div className="topbar">
          <div className="crumb">
            <h1>{tr("judge.title")}</h1>
            <span className="sub">{tr("judge.noSelection.subtitle")}</span>
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
              {tr("judge.noSelection.title")}
            </div>
            <p style={{ color: "var(--ink-3)", fontSize: 12.5, margin: "0 0 16px" }}>
              {tr("judge.noSelection.description")}
            </p>
            <button type="button" className="btn primary" onClick={onBack} style={{ margin: "0 auto" }}>
              {tr("judge.noSelection.action")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const status = jp?.status ?? "…";
  const agg = jp?.judge ?? null;
  const total = jp?.total ?? 0;
  // judge only ever covers RESOLVED tasks (done+fail+skip), so the ring/bar/pending
  // denominate on that — not the planned total, which would show phantom "pending" for
  // never-run tasks on a run stopped mid-Stage-A. `total` stays the headline count + "all"
  // tab (the planned set). Mirrors the pre-split Progress readout (judge.total = resolved).
  const resolved = jp?.resolved ?? total;
  const judged = agg?.judged ?? 0;
  const pass = agg?.pass ?? 0;
  const jfail = agg?.fail ?? 0;
  const err = agg?.err ?? 0;
  const pending = Math.max(0, resolved - judged);
  // judging = a judge subprocess is live: auto-judge (judge.status running) OR a judge-only
  // re-judge, authoritative even before the first judge file lands.
  const rejudging = jp?.judging ?? false;
  const judging = agg?.status === "running" || rejudging;
  // Current judge-job progress is null unless a
  // judge process is live with an unfinished judges/_job.json manifest.
  const job = jp?.job ?? null;
  // when judging isn't live and the judge readout isn't done, a terminal-failed run
  // (error/stopped) surfaces its own status instead of a neutral "pending" that would hide
  // the failure; a still-running or unjudged completed run stays pending.
  const failed = status === "error" || status === "stopped";
  const heroState = judging ? "judging" : agg?.status === "done" ? "done" : failed ? status : "pending";
  const heroLabel = judging
    ? tr("judge.states.judging")
    : agg?.status === "done"
      ? tr("judge.states.judged")
      : status === "error"
        ? tr("judge.states.error")
        : status === "stopped"
          ? tr("judge.states.stopped")
          : tr("judge.states.pending");

  // The ring draws pass, fail, and error over resolved tasks; pending is empty track.
  const C = 2 * Math.PI * 46;
  const seg = (n: number) => (resolved > 0 ? C * (n / resolved) : 0);
  const passLen = seg(pass);
  const failLen = seg(jfail);
  const errLen = seg(err);
  const judgedPct = resolved > 0 ? Math.round((judged / resolved) * 100) : 0;
  const jw = (n: number) => (resolved > 0 ? `${(n / resolved) * 100}%` : "0%");

  const tasks = jp?.tasks ?? [];
  // Counted from the task list, not the judge aggregate: these tasks are outside
  // `resolved` precisely because the judge never sees them.
  const captchaN = tasks.filter((t) => t.judge_status === "captcha").length;
  // The captcha tab disappears on a run without walls; don't strand the list on it.
  const activeFilter: Filter = filter === "captcha" && captchaN === 0 ? "all" : filter;
  const filtered = tasks.filter((t) => FILTER_MATCH[activeFilter](t.judge_status));

  // A queued row is targeted by this job, not yet redone, and has no in-flight
  // rubric sidecar → still waiting its turn.
  const jobTargetIds = new Set((job?.targets ?? []).map((x) => x.task_id));
  const jobDoneIds = new Set(job?.done_ids ?? []);

  // cart readouts: M tasks · N rubrics (N = total picked rubric ids across subset entries).
  const cartIds = Object.keys(cart);
  const cartRubricCount = cartIds.reduce((n, id) => n + (cart[id]?.length ?? 0), 0);
  const cartLabel =
    cartRubricCount > 0
      ? tr("judge.actions.cartWithRubrics", {
          tasks: cartIds.length,
          rubrics: cartRubricCount,
        })
      : tr("judge.actions.cartTasks", { tasks: cartIds.length });

  const doStop = async () => {
    try {
      await api.stopRun(liveId);
      message.info(tr("judge.feedback.stopSignalled", { runId: liveId }));
    } catch (e) {
      message.error(String(e));
    }
  };

  // whole-task toggle (row checkbox / header select-all). Checking replaces any rubric
  // subset with the whole task; unchecking drops the task from the cart entirely.
  const toggleWhole = (id: string, on: boolean) =>
    setCart((c) => {
      const next = { ...c };
      if (on) next[id] = null;
      else delete next[id];
      return next;
    });

  const judgeModelOptions = useMemo(
    () => models.filter((m) => m.images).map((m) => ({ value: `${m.provider}/${m.model}` })),
    [models],
  );

  // Prefill the re-judge modal from the run's frozen judge configuration.
  const openActionCfg = (target: "errors" | "cart", count: number) => {
    setAct({ target, count });
    setCfgNewRun(false);
    setCfgConc(cfg?.judge?.concurrency ?? null);
    setCfgModel(cfg?.judge?.model ?? "");
    setCfgMode(cfg?.judge?.mode ?? "");
  };

  const submitActionCfg = async () => {
    if (!liveId || !act) return;
    const body: {
      targets?: { task_id: string; rubric_ids?: string[] }[];
      errors?: boolean;
      concurrency?: number;
      model?: string;
      judge_mode?: string;
      new_run: boolean;
    } = { new_run: cfgNewRun };
    if (act.target === "errors") body.errors = true;
    else
      body.targets = cartIds.map((task_id) => {
        const rubs = cart[task_id];
        return rubs && rubs.length ? { task_id, rubric_ids: rubs } : { task_id };
      });
    if (cfgConc != null) body.concurrency = cfgConc;
    if (cfgModel.trim()) body.model = cfgModel.trim();
    if (cfgMode) body.judge_mode = cfgMode;
    setActSubmitting(true);
    try {
      const { run_id } = await api.rejudge(liveId, body);
      message.success(
        cfgNewRun
          ? tr("judge.feedback.derivedStarted", { runId: run_id })
          : tr("judge.feedback.rejudgeStarted", { runId: liveId }),
      );
      setCart({});
      setAct(null);
      if (run_id !== liveId) setLiveId(run_id);
      setReloadKey((k) => k + 1);
    } catch (e) {
      message.error(String(e));
    } finally {
      setActSubmitting(false);
    }
  };

  // Shared configuration: destination, concurrency, judge model, and judge mode.
  // Re-judge may override model/mode in either destination; overwrite is visually marked as
  // destructive because it replaces canonical verdicts and can make the run heterogeneous.
  const cfgBlock = () => (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12 }}>
      <Radio.Group
        value={cfgNewRun ? "new" : "overwrite"}
        onChange={(e) => setCfgNewRun(e.target.value === "new")}
        style={{ marginBottom: 12 }}
      >
        <Radio value="overwrite">
          <span style={{ color: cfgNewRun ? undefined : "var(--fail)" }}>
            {tr("judge.rerunDialog.overwrite")}
          </span>
        </Radio>
        <Radio value="new">{tr("judge.rerunDialog.create")}</Radio>
      </Radio.Group>
      <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <span style={{ marginRight: 8, fontSize: 12, color: "var(--ink-3)" }}>
            {tr("judge.rerunDialog.concurrency")}
          </span>
          <InputNumber
            min={1}
            value={cfgConc ?? undefined}
            onChange={(v) => setCfgConc(typeof v === "number" ? v : null)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span style={{ marginRight: 8, fontSize: 12, color: "var(--ink-3)" }}>
            {tr("judge.rerunDialog.judgeModel")}
          </span>
          <AutoComplete
            value={cfgModel}
            onChange={setCfgModel}
            options={judgeModelOptions}
            filterOption={(input, opt) =>
              String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())
            }
            style={{ minWidth: 220 }}
            placeholder={tr("judge.rerunDialog.modelPlaceholder")}
          />
        </div>
        <div>
          <span style={{ marginRight: 8, fontSize: 12, color: "var(--ink-3)" }}>
            {tr("judge.rerunDialog.judgeMode")}
          </span>
          <Select
            value={cfgMode || undefined}
            onChange={setCfgMode}
            options={[
              { value: "agent", label: tr("judge.rerunDialog.modes.agent") },
              { value: "single", label: tr("judge.rerunDialog.modes.single") },
            ]}
            style={{ minWidth: 120 }}
            placeholder={tr("judge.rerunDialog.modePlaceholder")}
          />
        </div>
      </div>
      {cfgNewRun ? (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "10px 0 0" }}>
          {tr("judge.rerunDialog.deriveDescription", { runId: liveId })}
        </p>
      ) : (
        <div
          style={{
            background: "var(--fail-soft)",
            borderLeft: "3px solid var(--fail)",
            color: "var(--fail)",
            fontSize: 11.5,
            lineHeight: 1.5,
            marginTop: 12,
            padding: "8px 10px",
          }}
        >
          <b>{tr("judge.rerunDialog.destructiveTitle")}</b>{" "}
          {tr("judge.rerunDialog.destructiveDescription", { runId: liveId })}
        </div>
      )}
    </div>
  );

  // Load the task's judge snapshot for the per-row picker with nothing selected
  // (the common case is auditing one or two rubrics — the old select-all default forced
  // unchecking everything). Re-opening a task with a subset in the cart restores it.
  const openRubricPicker = (taskId: string) => {
    if (!liveId) return;
    setRjTask(taskId);
    setRjData(null);
    setRjErr(null);
    setRjPicked(cart[taskId] ?? []);
    setRjLoading(true);
    api
      .taskJudge(liveId, taskId)
      .then((d) => setRjData(d))
      .catch((e) => setRjErr(String(e)))
      .finally(() => setRjLoading(false));
  };

  // picker confirm: write the subset into the cart (no request is sent here — execution
  // happens through the topbar submit). An empty pick removes the task from the cart.
  const savePicker = () => {
    if (!rjTask) return;
    const id = rjTask;
    setCart((c) => {
      const next = { ...c };
      if (rjPicked.length) next[id] = [...rjPicked].sort();
      else delete next[id];
      return next;
    });
    setRjTask(null);
  };

  const cfgRows: [string, any][] = cfg
    ? [
        [tr("judge.config.benchmark"), cfg.run?.benchmark],
        [tr("judge.config.agentProvider"), cfg.run?.provider ?? "pi"],
        [tr("judge.config.agentModel"), cfg.providers?.[cfg.run?.provider ?? "pi"]?.model],
        [tr("judge.config.judgeModel"), cfg.judge?.model],
        [tr("judge.config.judgeMode"), cfg.judge?.mode],
      ]
    : [];

  // judge hasn't begun until Stage A resolves; surface that instead of an empty zero-state.
  const stageARunning = status === "running" && !judging;

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <h1>{tr("judge.title")}</h1>
          <span className="sub">
            {liveId} · {heroLabel}
          </span>
        </div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={onBack}>
            {tr("judge.actions.back")}
          </button>
          {status !== "running" && agg && agg.err > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => openActionCfg("errors", agg.err)}
              disabled={rejudging}
              title={tr("judge.actions.errorsTitle")}
            >
              <Ico>
                <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
              </Ico>
              {rejudging
                ? tr("judge.actions.rejudging")
                : tr("judge.actions.errors", { count: agg.err })}
            </button>
          )}
          {status !== "running" && cartIds.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => openActionCfg("cart", cartIds.length)}
              disabled={rejudging}
              title={
                rejudging
                  ? tr("judge.actions.cartBusyTitle")
                  : tr("judge.actions.cartTitle")
              }
            >
              <Ico>
                <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" />
              </Ico>
              {cartLabel}
            </button>
          )}
          {rejudging && (
            <button type="button" className="btn danger" onClick={doStop}>
              <Ico>
                <rect x="4" y="4" width="8" height="8" rx="1.4" />
              </Ico>
              {tr("judge.actions.stop")}
            </button>
          )}
        </div>
      </div>

      <div className="view">
        <div className="prog-layout">
          {/* LEFT: judge ring + counts + config */}
          <div className="prog-side">
            <div className="prog-hero">
              <div className="top">
                <span className="rid2">{liveId}</span>
                <span className={`pill ${heroState === "pending" ? "queued" : heroState}`}>
                  <span className="dot" />
                  {heroLabel}
                </span>
              </div>

              <div className="ring-wrap">
                <div className="ring">
                  <svg width="108" height="108" viewBox="0 0 108 108">
                    <circle cx="54" cy="54" r="46" fill="none" stroke="var(--paper-2)" strokeWidth="11" />
                    <circle
                      cx="54" cy="54" r="46" fill="none" stroke="var(--done)" strokeWidth="11"
                      strokeLinecap="butt"
                      strokeDasharray={`${passLen} ${C - passLen}`}
                      strokeDashoffset={0}
                    />
                    <circle
                      cx="54" cy="54" r="46" fill="none" stroke="var(--fail)" strokeWidth="11"
                      strokeLinecap="butt"
                      strokeDasharray={`${failLen} ${C - failLen}`}
                      strokeDashoffset={-passLen}
                    />
                    <circle
                      cx="54" cy="54" r="46" fill="none" stroke="var(--amber)" strokeWidth="11"
                      strokeLinecap="butt"
                      strokeDasharray={`${errLen} ${C - errLen}`}
                      strokeDashoffset={-(passLen + failLen)}
                    />
                  </svg>
                  <div className="label">
                    <b>{judgedPct}%</b>
                    <span>{tr("judge.metrics.judged")}</span>
                  </div>
                </div>
                <div className="ring-legend">
                  <div className="li">
                    <span className="sw" style={{ background: "var(--done)" }} />
                    <span className="lbl">{tr("judge.metrics.pass")}</span>
                    <span className="n">{pass}</span>
                  </div>
                  <div className="li">
                    <span className="sw" style={{ background: "var(--fail)" }} />
                    <span className="lbl">{tr("judge.metrics.fail")}</span>
                    <span className="n">{jfail}</span>
                  </div>
                  <div className="li">
                    <span className="sw" style={{ background: "var(--amber)" }} />
                    <span className="lbl">{tr("judge.metrics.err")}</span>
                    <span className="n">{err}</span>
                  </div>
                  <div className="li">
                    <span className="sw" style={{ background: "var(--paper-2)", border: "1px solid var(--line-strong)" }} />
                    <span className="lbl">{tr("judge.metrics.pending")}</span>
                    <span className="n">{pending}</span>
                  </div>
                </div>
              </div>

              <div className="linbar-wrap">
                <div className="top">
                  <span>{tr("judge.metrics.judged")}</span>
                  <span>
                    {tr("judge.metrics.summary", { judged, resolved })}
                    {pending > 0 && tr("judge.metrics.pendingSuffix", { count: pending })}
                  </span>
                </div>
                <div className="linbar">
                  {resolved > 0 && <i className="d" style={{ width: jw(pass) }} />}
                  {resolved > 0 && <i className="f" style={{ width: jw(jfail) }} />}
                  {resolved > 0 && <i className="e" style={{ width: jw(err) }} />}
                </div>
                {/* This job's progress is separate from the full-run ring above. */}
                {job && job.total != null && (
                  <div className="jobline">
                    <span className="spin">⟳</span>{" "}
                    {tr("judge.metrics.job", { done: job.done ?? 0, total: job.total })}
                  </div>
                )}
              </div>

              <div className="counts judge" style={{ marginTop: 16 }}>
                <div className="c total">
                  <b>{total}</b>
                  <span>{tr("judge.metrics.total")}</span>
                </div>
                <div className="c judged">
                  <b>{judged}</b>
                  <span>{tr("judge.metrics.judged")}</span>
                </div>
                <div className="c done">
                  <b>{pass}</b>
                  <span>{tr("judge.metrics.pass")}</span>
                </div>
                <div className="c fail">
                  <b>{jfail}</b>
                  <span>{tr("judge.metrics.fail")}</span>
                </div>
                <div className="c err">
                  <b>{err}</b>
                  <span>{tr("judge.metrics.err")}</span>
                </div>
                <div className="c pending">
                  <b>{pending}</b>
                  <span>{tr("judge.metrics.pending")}</span>
                </div>
              </div>
            </div>

            <div className="prog-config">
              <h5>{tr("judge.config.title")}</h5>
              <div className="kv">
                {cfgRows.map(([k, v]) => (
                  <div className="row" key={k}>
                    <span className="k">{k}</span>
                    <span className="v">{v ?? "—"}</span>
                  </div>
                ))}
                {!cfg && !cfgErr && (
                  <div style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                    {tr("judge.config.loading")}
                  </div>
                )}
                {!cfg && cfgErr && (
                  <button
                    type="button"
                    onClick={() => setReloadKey((k) => k + 1)}
                    style={{
                      background: "none", border: "none", padding: 0, cursor: "pointer",
                      font: "inherit", textAlign: "left", color: "var(--fail)", fontSize: 11.5,
                    }}
                    title={tr("judge.config.loadFailedTitle")}
                  >
                    {tr("judge.config.loadFailed")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: per-task judge detail */}
          <div className="prog-main">
            <header>
              <h4>{tr("judge.detail.title")}</h4>
              <div className="filtertabs">
                <button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
                  {tr("judge.detail.filter", { label: tr("judge.detail.all"), count: total })}
                </button>
                <button type="button" className={filter === "pass" ? "on" : ""} onClick={() => setFilter("pass")}>
                  {tr("judge.detail.filter", { label: tr("judge.detail.pass"), count: pass })}
                </button>
                <button type="button" className={filter === "fail" ? "on" : ""} onClick={() => setFilter("fail")}>
                  {tr("judge.detail.filter", { label: tr("judge.detail.fail"), count: jfail })}
                </button>
                <button type="button" className={filter === "err" ? "on" : ""} onClick={() => setFilter("err")}>
                  {tr("judge.detail.filter", { label: tr("judge.detail.err"), count: err })}
                </button>
                <button type="button" className={filter === "pending" ? "on" : ""} onClick={() => setFilter("pending")}>
                  {tr("judge.detail.filter", {
                    label: tr("judge.detail.pending"),
                    count: pending,
                  })}
                </button>
                {/* Intercepted tasks are deliberately unjudged — a tab of their own keeps
                    them from reading as a judge backlog. Shown only when some exist. */}
                {captchaN > 0 && (
                  <button
                    type="button"
                    className={filter === "captcha" ? "on" : ""}
                    onClick={() => setFilter("captcha")}
                  >
                    {tr("judge.detail.filter", {
                      label: tr("judge.detail.captcha"),
                      count: captchaN,
                    })}
                  </button>
                )}
              </div>
            </header>
            <div className="tasklist judge">
              <div className="trow thead">
                <span className="tchk">
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={tr("judge.detail.selectAll")}
                    checked={filtered.length > 0 && filtered.every((t) => t.task_id in cart)}
                    onChange={(e) =>
                      setCart(
                        e.target.checked
                          ? Object.fromEntries(filtered.map((t) => [t.task_id, cart[t.task_id] ?? null]))
                          : {},
                      )
                    }
                  />
                </span>
                <span className="tnum" />
                <div className="tid">{tr("judge.detail.columns.task")}</div>
                <span className="th">{tr("judge.detail.columns.verdict")}</span>
                <span className="th">{tr("judge.detail.columns.time")}</span>
                <span className="th">{tr("judge.detail.columns.rubric")}</span>
                <span className="th">{tr("judge.detail.columns.cost")}</span>
                <span className="th">{tr("judge.detail.columns.session")}</span>
                <span className="th">{tr("judge.detail.columns.rubrics")}</span>
              </div>
              {filtered.map((t, i) => {
                const subset = cart[t.task_id];
                const inCart = t.task_id in cart;
                const queued =
                  job != null && jobTargetIds.has(t.task_id) && !jobDoneIds.has(t.task_id) && !t.judging_rubric;
                const verdictLabel =
                  t.judge_status === "pass"
                    ? tr("judge.states.pass")
                    : t.judge_status === "fail"
                      ? tr("judge.states.fail")
                      : t.judge_status === "err"
                        ? tr("judge.states.err")
                        : t.judge_status === "captcha"
                          ? tr("judge.states.captcha")
                          : tr("judge.states.pending");
                return (
                  <div className="trow" key={t.task_id}>
                    <span className="tchk">
                      <input
                        type="checkbox"
                        className="checkbox"
                        aria-label={tr("judge.detail.selectTask", { taskId: t.task_id })}
                        checked={inCart && subset == null}
                        ref={(el) => {
                          // Indeterminate means the cart contains a rubric subset.
                          if (el) el.indeterminate = inCart && subset != null;
                        }}
                        onChange={(e) => toggleWhole(t.task_id, e.target.checked)}
                      />
                    </span>
                    <span className="tnum">{String(i + 1).padStart(2, "0")}</span>
                    <div className="tid">{t.task_id}</div>
                    <span
                      className={`pill ${jPillClass(t.judge_status)}`}
                      title={t.judge_error ?? undefined}
                    >
                      {t.judge_status === "captcha" ? <CaptchaIco /> : <span className="dot" />}
                      {verdictLabel}
                    </span>
                    <span
                      className="tdur"
                      title={
                        t.turns != null
                          ? tr("judge.detail.durationWithTurns", { turns: t.turns })
                          : tr("judge.detail.duration")
                      }
                    >
                      {fmtClock(t.duration_s)}
                    </span>
                    {/* Rubric state progresses from in-flight to queued to pass/total. */}
                    {t.judging_rubric?.rubric_id != null ? (
                      <span
                        className="trubric live"
                        title={tr("judge.detail.judgingRubric", {
                          rubricId: t.judging_rubric.rubric_id,
                          done: t.judging_rubric.done ?? "—",
                          total: t.judging_rubric.total ?? "—",
                        })}
                      >
                        ⟳{t.judging_rubric.rubric_id} {t.judging_rubric.done ?? "—"}/
                        {t.judging_rubric.total ?? "—"}
                      </span>
                    ) : queued ? (
                      <span className="trubric queued" title={tr("judge.detail.queuedTitle")}>
                        {tr("judge.states.queued")}
                      </span>
                    ) : t.rubric_total != null ? (
                      <span className="trubric" title={tr("judge.detail.rubricsPassed")}>
                        {t.rubric_pass}/{t.rubric_total}
                      </span>
                    ) : (
                      <span className="trubric">—</span>
                    )}
                    <span className="tturns" title={tr("judge.detail.costTitle")}>
                      {fmtCost(t.cost_usd)}
                    </span>
                    {t.judge_session_url ? (
                      <a className="openlink" href={t.judge_session_url} target="_blank" rel="noreferrer">
                        {tr("judge.detail.open")}
                      </a>
                    ) : (
                      <span className="openlink muted">—</span>
                    )}
                    {status !== "running" && t.rubric_total != null ? (
                      <button
                        type="button"
                        className="openlink"
                        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left" }}
                        title={tr("judge.detail.pickTitle")}
                        onClick={() => openRubricPicker(t.task_id)}
                      >
                        {subset && subset.length
                          ? tr("judge.detail.picked", { count: subset.length })
                          : tr("judge.detail.rubrics")}
                      </button>
                    ) : (
                      <span className="openlink muted">—</span>
                    )}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ padding: "26px 18px", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
                  {!jp
                    ? tr("judge.detail.loading")
                    : stageARunning
                      ? tr("judge.detail.stageARunning")
                      : tr("judge.detail.empty")}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The rubric picker only updates the cart; the
          topbar "Re-judge (M tasks · N rubrics)" submits everything as ONE job. */}
      <Modal
        open={rjTask !== null}
        title={tr("judge.picker.title", { taskId: rjTask ?? "" })}
        onCancel={() => setRjTask(null)}
        onOk={savePicker}
        okText={
          rjPicked.length
            ? tr("judge.picker.addToCart", { count: rjPicked.length })
            : tr("judge.picker.removeFromCart")
        }
        okButtonProps={{ disabled: rjLoading }}
        width={560}
        destroyOnClose
      >
        {rjLoading ? (
          <div style={{ padding: 24, textAlign: "center" }}>
            <Spin />
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 0 }}>
              {tr("judge.picker.description")}
            </p>
            {rjErr && (
              <div style={{ fontSize: 12, color: "var(--fail)", marginBottom: 10 }}>
                {tr("judge.picker.loadFailed", { detail: rjErr })}
              </div>
            )}
            {rjData && (
              <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 12 }}>
                {tr("judge.picker.currentVerdict", { verdict: String(rjData.verdict) })}
                {rjData.score != null && tr("judge.picker.score", { score: rjData.score })}
                {rjData.judge_model && <> · {rjData.judge_model}</>}
              </div>
            )}
            {rjData?.has_rubrics && (
              <>
                <div style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    className="openlink"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
                    onClick={() =>
                      setRjPicked(
                        rjPicked.length === rjData.rubrics.length
                          ? []
                          : rjData.rubrics.map((r) => r.rubric_id),
                      )
                    }
                  >
                    {rjPicked.length === rjData.rubrics.length
                      ? tr("judge.picker.clearAll")
                      : tr("judge.picker.selectAll")}
                  </button>
                </div>
                <Checkbox.Group value={rjPicked} onChange={(v) => setRjPicked(v as string[])} style={{ display: "block" }}>
                  {rjData.rubrics.map((r) => (
                    <div
                      key={r.rubric_id}
                      style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--line)" }}
                    >
                      <Checkbox value={r.rubric_id} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: 12 }}>{r.rubric_id}</span>
                          <Tag color={r.satisfied ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                            {r.satisfied ? tr("judge.states.pass") : tr("judge.states.fail")}
                          </Tag>
                          {r.confidence != null && (
                            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                              {tr("judge.picker.confidence", { confidence: r.confidence })}
                            </span>
                          )}
                        </div>
                        {r.requirement && (
                          <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 3 }}>{r.requirement}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </Checkbox.Group>
              </>
            )}
            {rjData && !rjData.has_rubrics && (
              <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                {tr("judge.picker.noRubrics")}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Error and cart re-judge actions share one configuration form. */}
      <Modal
        open={act !== null}
        title={
          act
            ? act.target === "errors"
              ? tr("judge.rerunDialog.titleErrors", { count: act.count })
              : tr("judge.rerunDialog.titleCart", {
                  tasks: cartIds.length,
                  rubrics: cartRubricCount
                    ? tr("judge.rerunDialog.rubricSuffix", { count: cartRubricCount })
                    : "",
                })
            : ""
        }
        onCancel={() => setAct(null)}
        onOk={submitActionCfg}
        okText={cfgNewRun ? tr("judge.rerunDialog.create") : tr("judge.rerunDialog.confirm")}
        okButtonProps={{ danger: !cfgNewRun }}
        confirmLoading={actSubmitting}
        width={560}
        destroyOnClose
      >
        {act && (
          <div>
            <p style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 0 }}>
              {tr("judge.rerunDialog.description")}
            </p>
            {act.target === "cart" && cartRubricCount > 0 && (
              <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "0 0 4px" }}>
                {cartIds
                  .map((id) => {
                    const rubs = cart[id];
                    return rubs && rubs.length ? `${id} (${rubs.join(", ")})` : id;
                  })
                  .join(" · ")}
              </p>
            )}
            {cfgBlock()}
          </div>
        )}
      </Modal>
    </>
  );
}
