#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  disposeBrowserRuntime,
  invalidateSession,
  setPreferredTarget,
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import {
  bufferOutput,
  createRoundConsole,
  installLifecycleFlush,
  resetSink,
} from "./output-sink.js";
import { runMain } from "./run.js";
import { installStaleWiekBrowserGuard } from "./skill-migration.js";
import { emitUpdateNotice } from "./update-notice.js";
import { installPageContextGuard } from "./page-context-guard.js";
import { disposeDownloadArtifacts } from "./driver/downloads.js";

type HelperFunction = (...args: unknown[]) => unknown;
type WiekRuntime = Record<string, unknown> & {
  helpers?: Record<string, HelperFunction>;
  learnings?: Record<string, unknown>;
  getBrowserVersion?: () => unknown | Promise<unknown>;
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: unknown, errorCode?: string) => void;
};
type InstallTarget = Record<string, unknown> & {
  wiek?: WiekRuntime;
};
type InstallWiekSdkOptions = {
  context?: Record<string, unknown>;
  ready?: unknown;
  cliLog?: HelperFunction;
};

export * from "./helpers.js";
export { runMain } from "./run.js";

/** Release native callbacks before the host discards an embedded Node context. */
export async function disposeWiekSdk(target: InstallTarget = globalThis) {
  disposeDownloadArtifacts();
  disposeBrowserRuntime(target.wiek);
}

const SYNC_HELPERS = new Set(["help"]);
// Marks an wiek runtime whose mutating methods have already been wrapped, so a
// second installWiekSdk call cannot double-wrap createTab / task-space methods.
const WIEK_WRAPPED = Symbol.for("wiekBrowser.sdkWrapped");

export function installWiekSdk(
  target: InstallTarget = globalThis,
  options: InstallWiekSdkOptions = {},
) {
  if (!target || typeof target !== "object") {
    return target;
  }
  if (target === globalThis) installPageContextGuard(target);
  const usingDefaultCliLog = !options.cliLog;
  const cliLogFn = options.cliLog || createCliLog();
  const context =
    options.context ||
    helpers.helperContext({}, { printHelp: (text) => cliLogFn(text) });
  const readySignal = Promise.resolve(options.ready);
  // The host may reject readiness before a helper is called. Mark the promise
  // as observed while preserving the same rejection for every helper await.
  void readySignal.catch(() => {});
  const installed: Record<string, HelperFunction> = {};
  for (const [name, value] of Object.entries(context)) {
    if (typeof value !== "function") {
      continue;
    }
    const exposed = SYNC_HELPERS.has(name)
      ? value
      : async (...args: unknown[]) => {
          await readySignal;
          return value(...args);
        };
    Object.defineProperty(target, name, {
      value: exposed,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    installed[name] = exposed as HelperFunction;
  }
  // Non-function values are intentionally absent from the normal helper loop.
  // Install the 1.3 migration guard explicitly so embedded SDK execution and
  // the direct CLI produce the same actionable error.
  installStaleWiekBrowserGuard(target);
  Object.defineProperty(target, "cliLog", {
    value: cliLogFn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  installed.cliLog = cliLogFn;
  Object.defineProperty(target, "console", {
    value: createRoundConsole(
      usingDefaultCliLog
        ? undefined
        : (line) => cliLogFn(line.endsWith("\n") ? line.slice(0, -1) : line),
    ),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  if (usingDefaultCliLog) {
    // SDK path: the host runs each heredoc in a fresh short-lived process and never
    // calls execute(), so reset the per-run sink and flush it on process teardown.
    resetSink();
    installLifecycleFlush(process.stdout);
  }
  if (target.wiek && typeof target.wiek === "object") {
    void emitUpdateNotice(target.wiek, (line) => {
      if (usingDefaultCliLog) bufferOutput(`${line}\n`);
      else cliLogFn(line);
    });
    target.wiek.helpers = installed;
    target.wiek.learnings = {};
    if (!(target.wiek as Record<symbol, unknown>)[WIEK_WRAPPED]) {
      const taskSelection: { spaceId?: unknown } = {};
      wrapCreateTab(target.wiek);
      wrapUseTaskSpace(target.wiek, taskSelection);
      wrapInvalidating(
        target.wiek,
        ["closeTaskSpace", "createTaskSpace", "claimTaskSpace"],
        () => {
          taskSelection.spaceId = undefined;
        },
      );
      Object.defineProperty(target.wiek, WIEK_WRAPPED, {
        value: true,
        enumerable: false,
      });
    }
    exposeWiekMethods(target, target.wiek);
  }
  return target;
}

if (isDirectCli()) {
  try {
    process.exitCode = await runMain();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    disposeDownloadArtifacts();
  }
} else {
  installWiekSdk();
}

function createCliLog() {
  return (...args: unknown[]) => {
    // Buffer instead of writing through: a hard stop later in the run must be able to
    // discard everything logged so far. The buffer is flushed on process teardown.
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
}

function isDirectCli() {
  return (
    process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
  );
}

function wrapInvalidating(
  wiek: WiekRuntime,
  methodNames: string[],
  resetSelection: () => void = () => {},
) {
  for (const name of methodNames) {
    const original = wiek[name];
    if (typeof original !== "function") continue;
    const after = () => {
      resetSelection();
      invalidateSession();
      clearPreferredTarget();
    };
    wiek[name] = function (...args: unknown[]) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          after();
          return value;
        });
      }
      after();
      return result;
    };
  }
}

function wrapUseTaskSpace(wiek: WiekRuntime, selection: { spaceId?: unknown }) {
  // File chooser waits and other event subscriptions span multiple Page calls.
  // Re-selecting the same space must preserve their CDP session; changing the
  // space still invalidates every session because native routing is global.
  const original = wiek.useTaskSpace;
  if (typeof original !== "function") return;
  const after = (spaceId: unknown, value: unknown) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "error")) {
      return value;
    }
    if (selection.spaceId !== spaceId) {
      invalidateSession();
      clearPreferredTarget();
      selection.spaceId = spaceId;
    }
    return value;
  };
  wiek.useTaskSpace = function (...args: unknown[]) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => after(args[0], value));
    }
    return after(args[0], result);
  };
}

function wrapCreateTab(wiek: WiekRuntime) {
  const original = wiek.createTab;
  if (typeof original !== "function") return;
  wiek.createTab = function (...args: unknown[]) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        const id = value?.targetId || value?.result?.targetId;
        if (id) setPreferredTarget(id);
        return value;
      });
    }
    return result;
  };
}

function exposeWiekMethods(target: InstallTarget, wiek: WiekRuntime) {
  const skip = new Set([
    "helpers",
    "learnings",
    "useTaskSpace",
    "createTaskSpace",
    "claimTaskSpace",
    "closeTaskSpace",
  ]);
  for (const key of Object.keys(wiek)) {
    if (skip.has(key)) continue;
    if (key in target) continue;
    const value = wiek[key];
    if (typeof value !== "function") continue;
    const bound = value.bind(wiek);
    Object.defineProperty(target, key, {
      value: bound,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
