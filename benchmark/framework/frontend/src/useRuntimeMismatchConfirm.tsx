import { App as AntdApp } from "antd";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { isRuntimeMismatch } from "./api";

/**
 * Wraps a rerun/resume call with the wiek-browser runtime confirmation.
 *
 * The backend refuses these actions once when the active runtime is no longer the one the
 * run was recorded against, because continuing mixes two runtimes across one run's tasks.
 * That is a judgement call, not an error, so it is put to the user: confirming re-sends the
 * same request with the acceptance attached, which the spawned run also records.
 */
export function useRuntimeMismatchConfirm() {
  const { modal } = AntdApp.useApp();
  const { t } = useTranslation();

  /**
   * Returns the action's result, or null when the user declined — nothing ran and nothing
   * failed, so callers should report neither. Every other error propagates unchanged.
   */
  return useCallback(
    async <T,>(attempt: (allowRuntimeMismatch: boolean) => Promise<T>): Promise<T | null> => {
      try {
        return await attempt(false);
      } catch (e) {
        if (!isRuntimeMismatch(e)) throw e;
        const accepted = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: t("common.runtimeMismatch.title"),
            width: 540,
            content: (
              <div>
                <p style={{ margin: "0 0 10px" }}>{t("common.runtimeMismatch.body")}</p>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    lineHeight: 1.6,
                    color: "var(--ink-2)",
                    background: "var(--paper-2)",
                    border: "1px solid var(--line)",
                    padding: "8px 10px",
                    wordBreak: "break-all",
                  }}
                >
                  {(e as Error).message}
                </div>
                <p style={{ margin: "10px 0 0", color: "var(--ink-3)" }}>
                  {t("common.runtimeMismatch.hint")}
                </p>
              </div>
            ),
            okText: t("common.runtimeMismatch.confirm"),
            cancelText: t("common.actions.cancel"),
            okButtonProps: { danger: true },
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        return accepted ? await attempt(true) : null;
      }
    },
    [modal, t],
  );
}
