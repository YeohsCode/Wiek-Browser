import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "./LanguageSwitcher";

export type View = "newrun" | "runs" | "progress" | "judge" | "artifacts";

// Widths below the snap threshold collapse to the icon-only rail.
export const SIDE_DEFAULT_W = 232;
export const SIDE_COLLAPSED_W = 64;
const SIDE_MIN_W = 180;
const SIDE_MAX_W = 400;
const SIDE_SNAP_W = 150;

export function normalizeSideWidth(raw: number): number {
  if (raw < SIDE_SNAP_W) return SIDE_COLLAPSED_W;
  return Math.min(SIDE_MAX_W, Math.max(SIDE_MIN_W, Math.round(raw)));
}

interface Props {
  view: View;
  runCount: number;
  width: number;
  onNav: (v: View) => void;
  onWidthChange: (w: number, commit: boolean) => void;
}

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      {children}
    </svg>
  );
}

// Drag the persistent left rail's right edge to resize,
// drop below the snap threshold to collapse to an icon-only rail.
export default function Sidebar({ view, runCount, width, onNav, onWidthChange }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const collapsed = width <= SIDE_COLLAPSED_W;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const left = ref.current?.getBoundingClientRect().left ?? 0;
    const onMove = (ev: PointerEvent) => onWidthChange(normalizeSideWidth(ev.clientX - left), false);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onWidthChange(normalizeSideWidth(ev.clientX - left), true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const item = (v: View, label: string, icon: ReactNode, extra?: ReactNode) => (
    <button className={view === v ? "on" : ""} title={collapsed ? label : undefined} onClick={() => onNav(v)}>
      <NavIcon>{icon}</NavIcon>
      <span className="ntxt">{label}</span>
      {extra}
    </button>
  );

  return (
    <aside className={`side${collapsed ? " collapsed" : ""}`} ref={ref}>
      <div className="brand">
        <div className="mark">
          <span className="wm" />
        </div>
        <div className="txt">
          <b>wiek·bench</b>
          <span>console</span>
        </div>
      </div>

      <nav className="nav">
        <div className="lbl">{t("shell.groups.workspace")}</div>
        {item("newrun", t("shell.nav.newRun"), <path d="M8 3v10M3 8h10" />)}
        {item(
          "runs",
          t("shell.nav.runs"),
          <>
            <rect x="2.5" y="3" width="11" height="2.4" rx=".6" />
            <rect x="2.5" y="7" width="11" height="2.4" rx=".6" />
            <rect x="2.5" y="11" width="7" height="2.4" rx=".6" />
          </>,
          runCount > 0 && !collapsed ? <span className="count">{runCount}</span> : undefined,
        )}
        {item(
          "progress",
          t("shell.nav.progress"),
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 8l2.4-2.4" />
          </>,
        )}
        {item(
          "judge",
          t("shell.nav.judge"),
          <>
            <path d="M8 2v12M3.2 6h9.6" />
            <path d="M3.2 6L1.6 9.5h3.2zM12.8 6l-1.6 3.5h3.2z" />
          </>,
        )}

        <div className="lbl" style={{ marginTop: 14 }}>
          {t("shell.groups.artifacts")}
        </div>
        {item(
          "artifacts",
          t("shell.nav.artifacts"),
          <>
            <path d="M2.5 5.5L8 2.5l5.5 3L8 8.5z" />
            <path d="M2.5 5.5v5L8 13.5l5.5-3v-5" />
            <path d="M8 8.5v5" />
          </>,
        )}
      </nav>

      <div className="foot">
        <LanguageSwitcher collapsed={collapsed} />
        <div className="host">
          <span className="ping" />
          {window.location.host || "127.0.0.1:8365"}
        </div>
        <div className="ver">{t("shell.version")}</div>
      </div>

      <div className="side-resizer" onPointerDown={startDrag} title={t("shell.sidebarResize")} />
    </aside>
  );
}
