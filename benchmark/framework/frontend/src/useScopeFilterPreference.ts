import { useState } from "react";

type ScopeFilterPage = "runs" | "artifacts";
type ScopeFilterMode = "cascade" | "independent";

interface ScopeFilterPreference {
  provider: string;
  model: string;
  dataset: string;
}

const DEFAULT_PREFERENCE: ScopeFilterPreference = {
  provider: "all",
  model: "all",
  dataset: "all",
};

const storageKey = (page: ScopeFilterPage): string => `wiek.scopeFilters:v2:${page}`;
const legacyStorageKey = (page: ScopeFilterPage): string => `wiek.scopeFilters:v1:${page}`;

function parseObject(raw: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(raw);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parsePreference(raw: string): ScopeFilterPreference | null {
  const value = parseObject(raw);
  if (
    value &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.dataset === "string" &&
    value.dataset.length > 0
  ) {
    return { provider: value.provider, model: value.model, dataset: value.dataset };
  }
  return null;
}

function writePreference(page: ScopeFilterPage, preference: ScopeFilterPreference): boolean {
  try {
    localStorage.setItem(storageKey(page), JSON.stringify(preference));
    return true;
  } catch {
    // The in-memory selection still works when browser storage is unavailable.
    return false;
  }
}

function readPreference(page: ScopeFilterPage): ScopeFilterPreference {
  try {
    const raw = localStorage.getItem(storageKey(page));
    if (raw !== null) return parsePreference(raw) ?? { ...DEFAULT_PREFERENCE };

    const legacyRaw = localStorage.getItem(legacyStorageKey(page));
    if (legacyRaw === null) return { ...DEFAULT_PREFERENCE };
    const legacy = parseObject(legacyRaw);
    if (
      legacy &&
      typeof legacy.provider === "string" &&
      legacy.provider.length > 0 &&
      typeof legacy.dataset === "string" &&
      legacy.dataset.length > 0
    ) {
      const migrated = { provider: legacy.provider, model: "all", dataset: legacy.dataset };
      if (writePreference(page, migrated)) {
        try {
          localStorage.removeItem(legacyStorageKey(page));
        } catch {
          // The v2 value is already authoritative; a stale v1 key is inert.
        }
      }
      return migrated;
    }
  } catch {
    // localStorage is an external browser boundary and may be unavailable or malformed.
  }
  return { ...DEFAULT_PREFERENCE };
}

export function resolveFilterPreference(preference: string, available: ReadonlySet<string>): string {
  return preference === "all" || available.has(preference) ? preference : "all";
}

export function modelFilterKey(model: string | null): string {
  const value = model?.trim();
  if (!value) return "unknown";
  const slash = value.lastIndexOf("/");
  return slash < 0 ? value : value.slice(slash + 1) || "unknown";
}

export function useScopeFilterPreference(page: ScopeFilterPage, mode: ScopeFilterMode = "cascade") {
  const [preference, setPreference] = useState<ScopeFilterPreference>(() => readPreference(page));

  const commit = (next: ScopeFilterPreference): void => {
    setPreference(next);
    writePreference(page, next);
  };

  const selectProvider = (provider: string): void => {
    commit(
      mode === "cascade"
        ? { provider, model: "all", dataset: "all" }
        : { ...preference, provider },
    );
  };

  const selectModel = (provider: string, model: string): void => {
    commit(
      mode === "cascade"
        ? { provider, model, dataset: "all" }
        : { ...preference, provider, model },
    );
  };

  const selectDataset = (provider: string, model: string, dataset: string): void => {
    commit({ provider, model, dataset });
  };

  return { preference, selectProvider, selectModel, selectDataset };
}
