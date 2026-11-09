import { useState } from "react";
import { App as AntdApp } from "antd";
import { useTranslation } from "react-i18next";
import Sidebar, { SIDE_DEFAULT_W, normalizeSideWidth, type View } from "./components/Sidebar";
import ConfigForm from "./components/ConfigForm";
import RunsPanel from "./components/RunsPanel";
import ProgressDashboard from "./components/ProgressDashboard";
import JudgeDashboard from "./components/JudgeDashboard";
import ArtifactsPanel from "./components/ArtifactsPanel";
import { api } from "./api";

const SIDE_W_KEY = "wiek.sideWidth";

function storedSideWidth(): number {
  try {
    const raw = Number.parseInt(window.localStorage.getItem(SIDE_W_KEY) || "", 10);
    return normalizeSideWidth(raw || SIDE_DEFAULT_W);
  } catch {
    return SIDE_DEFAULT_W;
  }
}

export default function App() {
  const { message } = AntdApp.useApp();
  const { t } = useTranslation();
  const [view, setView] = useState<View>("newrun");
  // Progress is run-scoped: select which run to display.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Record<string, any> | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runTotal, setRunTotal] = useState(0);
  // Persist the drag-resizable sidebar width across sessions.
  const [sideW, setSideW] = useState<number>(storedSideWidth);

  const onSideWidth = (w: number, commit: boolean) => {
    setSideW(w);
    if (commit) {
      try {
        window.localStorage.setItem(SIDE_W_KEY, String(w));
      } catch {
        // The current in-memory width still applies when storage is unavailable.
      }
    }
  };

  const handleNav = (v: View) => {
    // Sidebar "Progress"/"Judge" with no target → route to Runs and guide selection
    // (both are run-scoped and share activeRunId).
    if ((v === "progress" || v === "judge") && !activeRunId) {
      message.info(t("shell.openFromRun", { view: t(v === "judge" ? "shell.nav.judge" : "shell.nav.progress") }));
      setView("runs");
      setRefreshKey((k) => k + 1);
      return;
    }
    if (v === "runs") setRefreshKey((k) => k + 1);
    setView(v);
  };

  const openProgress = (runId: string) => {
    setActiveRunId(runId);
    setView("progress");
  };

  const reuseConfig = async (runId: string) => {
    try {
      const cfg = await api.runConfig(runId);
      setPrefill(cfg);
      setView("newrun");
      message.success(t("shell.loadedConfig", { runId }));
    } catch (e) {
      message.error(String(e));
    }
  };

  const onStarted = (runId: string, queued: boolean) => {
    // A queued run has no run directory yet, so its progress view would have nothing
    // to show. Send it to Runs instead, where it appears in the queue group.
    if (queued) {
      setView("runs");
      setRefreshKey((k) => k + 1);
      return;
    }
    // Mirror the design: launching drops straight into the run's progress.
    setActiveRunId(runId);
    setView("progress");
  };

  return (
    <div className="app" style={{ ["--side-w" as any]: `${sideW}px` }}>
      <Sidebar view={view} runCount={runTotal} width={sideW} onNav={handleNav} onWidthChange={onSideWidth} />
      <main className="main">
        {view === "newrun" && <ConfigForm prefill={prefill} onStarted={onStarted} />}
        {view === "runs" && (
          <RunsPanel
            refreshKey={refreshKey}
            onReuse={reuseConfig}
            onOpenProgress={openProgress}
            onCounts={setRunTotal}
            onNewRun={() => setView("newrun")}
          />
        )}
        {view === "progress" && (
          <ProgressDashboard runId={activeRunId} onBack={() => handleNav("runs")} />
        )}
        {view === "judge" && (
          <JudgeDashboard runId={activeRunId} onBack={() => handleNav("runs")} />
        )}
        {view === "artifacts" && <ArtifactsPanel />}
      </main>
    </div>
  );
}
