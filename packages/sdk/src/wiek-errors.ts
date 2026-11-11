/**
 * Shared handling for wiek-binding errors.
 *
 * Browser-side failures expose two signals (see the WiekBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as WIEK_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isWiekUserControlError), not on the message. WIEK_ERROR_MESSAGES is
 * where wiek-browser owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */

import { markHardStop } from "./output-sink.js";

/** Stable error codes emitted by the native wiek bindings. */
export const WIEK_ERROR_CODES = [
  "WIEK_BROWSER_UNAVAILABLE",
  "WIEK_CDP_CHANNEL_UNAVAILABLE",
  "WIEK_CDP_SEND_FAILED",
  "WIEK_INVALID_ARGUMENT",
  "WIEK_INVALID_RESULT_PAYLOAD",
  "WIEK_OPERATION_FAILED",
  "WIEK_RESULT_CONVERSION_FAILED",
  "WIEK_SNAPSHOT_FAILED",
  "WIEK_TASK_HOST_DISCONNECTED",
  "WIEK_TASK_SPACE_INACTIVE",
  "WIEK_TASK_SPACE_NAME_IN_USE",
  "WIEK_TASK_SPACE_NOT_FOUND",
  "WIEK_TASK_SPACE_NOT_SELECTED",
  "WIEK_TASK_SPACE_UNAVAILABLE",
  "WIEK_TASK_SPACE_USER_IN_CONTROL",
  "WIEK_WEB_CONTENTS_UNAVAILABLE",
] as const;

export type WiekErrorCode = (typeof WIEK_ERROR_CODES)[number];

/**
 * Codes whose wording wiek-browser owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const WIEK_ERROR_MESSAGES: Partial<Record<WiekErrorCode, string>> = {
  // The native code does not say who ended the task or moved control: the
  // agent's own task.finish() / task.handOff() produce the same codes as user
  // actions in the browser. Keep this wording neutral about the cause.
  WIEK_TASK_SPACE_INACTIVE: [
    "This task space is no longer assigned to the agent: its task has ended, either through task.finish() or by the user, so browser commands are paused.",
    "takeOverTaskSpace() cannot resume an ended task. For a new authorized test, create a fresh taskSpace with a unique run name.",
    "If the user already authorized continuing in these pages, claim the group by id. Otherwise ask before using their pages:",
    "  const task = await claimTaskSpace(spaceId)",
    "",
    "After claiming, list task.tabs() and adopt the intended unlabeled tab. Finished tasks have ended their previous Page labels.",
  ].join("\n"),
  WIEK_TASK_SPACE_USER_IN_CONTROL: [
    "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
    "Pause actions in this group while the user is interacting with it.",
    "After the user authorizes returning control, take it back with:",
    "  const task = await takeOverTaskSpace(spaceId)",
    "",
    "Existing instructions to resume are sufficient. Permission prompts and device choosers still require the user to handle them.",
  ].join("\n"),
};

const USER_CONTROL_GUIDANCE =
  WIEK_ERROR_MESSAGES.WIEK_TASK_SPACE_USER_IN_CONTROL as string;

const USER_CONTROL_REASON_MESSAGES = Object.freeze({
  notifications: permissionPrompt("notifications"),
  location: permissionPrompt("location access"),
  camera: permissionPrompt("camera access"),
  microphone: permissionPrompt("microphone access"),
  pan_tilt_zoom_microphone: permissionPrompt(
    "camera control and microphone access",
  ),
  midi: permissionPrompt("MIDI device access"),
  bluetooth: userPromptGuidance(
    "A browser device chooser for Bluetooth has appeared.",
  ),
  usb: userPromptGuidance("A browser device chooser for USB has appeared."),
  serial: userPromptGuidance(
    "A browser port chooser for serial access has appeared.",
  ),
  hid: userPromptGuidance("A browser device chooser for HID has appeared."),
  protocol_handler: permissionPrompt("protocol handler registration"),
  manual_takeover: USER_CONTROL_GUIDANCE,
});

function permissionPrompt(access: string): string {
  return userPromptGuidance(
    `A browser permission prompt for ${access} has appeared.`,
  );
}

function userPromptGuidance(firstLine: string): string {
  return [
    firstLine,
    "The user now controls this task space. Wait for the user to handle the prompt.",
    "Resume only after the user confirms, using takeOverTaskSpace(spaceId).",
  ].join("\n");
}

/** Type guard for codes this build knows about. */
export function isWiekErrorCode(value: unknown): value is WiekErrorCode {
  return (
    typeof value === "string" &&
    (WIEK_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Pull the stable error_code out of any wiek error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
export function wiekErrorCode(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isWiekErrorCode(err) ? err : undefined;
  }
  if (err && typeof err === "object") {
    const code = (err as Record<string, unknown>).error_code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/**
 * Resolve any wiek error into a stable `{ code, message }` pair.
 *
 * For a code wiek-browser owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
export function resolveWiekError(err: unknown): {
  code?: string;
  message: string;
} {
  const code = wiekErrorCode(err);
  const message =
    (code === "WIEK_TASK_SPACE_USER_IN_CONTROL"
      ? resolveUserControlMessage(err)
      : isWiekErrorCode(code)
        ? WIEK_ERROR_MESSAGES[code]
        : undefined) ??
    nativeErrorText(err) ??
    code ??
    "Unknown wiek error";
  return { code, message };
}

function resolveUserControlMessage(err: unknown): string {
  const nativeText = nativeErrorText(err);
  if (nativeText && Object.hasOwn(USER_CONTROL_REASON_MESSAGES, nativeText)) {
    return USER_CONTROL_REASON_MESSAGES[
      nativeText as keyof typeof USER_CONTROL_REASON_MESSAGES
    ];
  }
  return USER_CONTROL_GUIDANCE;
}

/** Whether an wiek error means the task is currently under user control. */
export function isWiekUserControlError(err: unknown): boolean {
  return wiekErrorCode(err) === "WIEK_TASK_SPACE_USER_IN_CONTROL";
}

/**
 * Probe control without turning the expected user-control response into a hard
 * stop. Wiek bindings can report failures either by rejecting or by resolving an
 * `{ error, error_code }` object, so both paths must be inspected here.
 */
export async function probeAgentControl(
  invokeSnapshot: () => unknown | Promise<unknown>,
): Promise<boolean> {
  let result: unknown;
  try {
    result = await invokeSnapshot();
  } catch (error) {
    if (isWiekUserControlError(error)) return false;
    throw error;
  }
  if (isResolvedWiekError(result)) {
    if (isWiekUserControlError(result)) return false;
    throw buildWiekError(result);
  }
  return true;
}

function isResolvedWiekError(
  value: unknown,
): value is { error: unknown; error_code?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { error?: unknown }).error != null
  );
}

/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isWiekHardStopCode(code: string | undefined): boolean {
  return (
    code === "WIEK_TASK_SPACE_USER_IN_CONTROL" ||
    code === "WIEK_TASK_SPACE_INACTIVE"
  );
}

/**
 * Build an Error carrying the resolved message and stable error_code from any wiek
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by invokeWiek and the CDP-send failure path so every wiek failure surfaces
 * an identical Error shape.
 */
export function buildWiekError(
  err: unknown,
  op?: string,
): Error & { error_code?: string } {
  const { code, message } = resolveWiekError(err);
  if (isWiekHardStopCode(code)) {
    // buildWiekError is the single birthplace of every wiek error — invokeWiek and the
    // CDP-send failure path both route through it — so recording the hard stop here
    // catches it even when the agent's own try/catch later swallows the thrown Error.
    // The op-less owned message is the one the agent should see, regardless of which
    // operation surfaced it.
    markHardStop(message);
  }
  const error: Error & { error_code?: string } = new Error(
    op ? `${op}: ${message}` : message,
  );
  if (code) error.error_code = code;
  return error;
}

/**
 * Invoke a native binding and normalize synchronous throws, rejected Promises, and
 * resolved `{ error, error_code }` objects. Control-wait probes intentionally bypass
 * this helper because observing user control is their expected result, not a hard stop.
 */
export async function invokeWiek<T>(
  op: string,
  invoke: () => T | Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    throw buildWiekError(error, op);
  }
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    result.error != null
  ) {
    throw buildWiekError(result, op);
  }
  return result;
}

/**
 * The native error message from any wiek error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isWiekErrorCode(err) ? undefined : err;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.error != null) return formatWiekError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return undefined;
}

export function formatWiekError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
