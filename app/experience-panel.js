"use strict";
(() => {
  const tr = (message, ...values) =>
    globalThis.WiekI18n?.t(message, ...values) ??
    message.replace(/\{(\d+)\}/g, (_, i) => values[i]);
  let root,
    invoke,
    data = {
      settings: { enabled: false, mode: "hints" },
      revision: 0,
      runs: [],
      candidates: [],
    },
    busy = false,
    error = "";
  const notes = new Map();
  const el = (tag, value) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const button = (label, callback) => {
    const node = el("button", tr(label));
    node.type = "button";
    node.disabled = busy;
    node.onclick = callback;
    return node;
  };
  function update(state) {
    if (state?.experience) data = state.experience;
    else if (state?.settings && Array.isArray(state.candidates)) data = state;
    render();
  }
  async function act(action, payload = {}) {
    if (busy) return;
    busy = true;
    error = "";
    render();
    try {
      update(
        await invoke(`experience:${action}`, {
          ...payload,
          expectedRevision: data.revision,
        }),
      );
    } catch (failure) {
      error = globalThis.WiekI18n?.error(failure.message) ?? failure.message;
    } finally {
      busy = false;
      render();
    }
  }
  function card(title) {
    const node = el("section");
    node.className = "card";
    node.append(el("h3", tr(title)));
    root.append(node);
    return node;
  }
  function render() {
    if (
      !root?.isConnected ||
      globalThis.WiekI18n?.deferWhileComposing(root, render)
    )
      return;
    root.replaceChildren();
    root.append(
      el("h2", tr("Browser operation experience")),
      el(
        "p",
        tr(
          "Save task outcomes locally, review suggested improvements, and reuse checked steps on the same website.",
        ),
      ),
    );
    if (error) {
      const alert = el("p", error);
      alert.setAttribute("role", "alert");
      root.append(alert);
    }
    const settings = card("Recording and reuse");
    settings.append(
      el(
        "p",
        tr(
          "Off by default. Automatic records exclude typed values, credentials, page contents, and URL query strings. Text in checks and suggestions is saved only when explicitly supplied.",
        ),
      ),
    );
    settings.append(
      button(
        data.settings.enabled
          ? "Disable operation experience"
          : "Enable operation experience",
        () =>
          act("settings", {
            enabled: !data.settings.enabled,
            mode: data.settings.mode,
          }),
      ),
    );
    const label = el("label", tr("Reuse mode")),
      mode = el("select");
    mode.setAttribute("aria-label", tr("Reuse mode"));
    mode.disabled = busy;
    for (const [value, title] of [
      ["hints", "Reviewed suggestions only"],
      ["replay", "Reviewed suggestions and checked step replay"],
    ]) {
      const option = el("option", tr(title));
      option.value = value;
      option.selected = data.settings.mode === value;
      mode.append(option);
    }
    mode.onchange = () =>
      act("settings", { enabled: data.settings.enabled, mode: mode.value });
    label.append(mode);
    settings.append(label);
    settings.append(
      el(
        "p",
        tr(
          "Replay can click buttons. Review the recorded checks and effects before enabling it. A failed or uncertain step pauses without retrying.",
        ),
      ),
    );
    const candidates = card("Suggestions awaiting review");
    if (!data.candidates.length)
      candidates.append(
        el(
          "p",
          tr(
            "No suggestions yet. Record a task and check its result before proposing an improvement.",
          ),
        ),
      );
    for (const candidate of data.candidates) {
      const version = candidate.versions.find(
          (v) => v.number === candidate.version,
        ),
        row = el("article");
      row.className = "card";
      row.dataset.experienceId = candidate.id;
      row.append(
        el("h4", candidate.task),
        el("p", candidate.origin),
        el(
          "p",
          tr("{0} · Version {1}", tr(candidate.status), candidate.version),
        ),
        el("p", tr(version.note)),
      );
      row.append(
        el("p", tr("{0} verified observations", version.observations || 0)),
      );
      row.append(
        el(
          "p",
          tr(
            "{0} checked steps · {1}",
            version.steps.length,
            tr(
              version.completeWorkflow
                ? "Complete checked workflow"
                : "Suggestions or partial steps only",
            ),
          ),
        ),
      );
      const evidence = el("details");
      evidence.append(el("summary", tr("Checks and recorded evidence")));
      const run = data.runs.find((r) => r.id === candidate.runId);
      evidence.append(
        el(
          "pre",
          JSON.stringify(
            {
              source: version.source,
              checks: version.checks,
              steps: version.steps,
              evidence: run?.events || [],
            },
            null,
            2,
          ),
        ),
      );
      row.append(evidence);
      const payload = { id: candidate.id, version: candidate.version };
      row.append(
        button("Enable reviewed suggestion", () =>
          act("review", { ...payload, status: "enabled" }),
        ),
        button("Reject suggestion", () =>
          act("review", { ...payload, status: "rejected" }),
        ),
      );
      const editor = el("textarea");
      editor.value =
        notes.get(candidate.id + "@" + candidate.version) ?? version.note;
      editor.oninput = () =>
        notes.set(candidate.id + "@" + candidate.version, editor.value);
      editor.maxLength = 1000;
      editor.setAttribute("aria-label", tr("Suggestion text"));
      row.append(
        editor,
        button("Save as a new draft", () =>
          act("edit", { ...payload, note: editor.value }),
        ),
      );
      if (candidate.versions.length > 1) {
        const previous = el("select");
        previous.setAttribute("aria-label", tr("Previous version"));
        for (const v of candidate.versions.filter(
          (v) => v.number !== candidate.version,
        )) {
          const option = el("option", tr("Version {0}", v.number));
          option.value = String(v.number);
          previous.append(option);
        }
        row.append(
          previous,
          button("Restore as a new draft", () =>
            act("rollback", {
              ...payload,
              operationId: Number(previous.value),
            }),
          ),
        );
      }
      row.append(button("Delete suggestion", () => act("delete", payload)));
      candidates.append(row);
    }
    const history = card("Recorded task results");
    history.append(
      el(
        "p",
        tr(
          "Records and suggestions are limited to the current browser profile and project. Deleting records also deletes their suggestions.",
        ),
      ),
    );
    for (const run of data.runs) {
      const item = el("details");
      item.append(
        el("summary", `${run.task} · ${tr(run.status)}`),
        el("pre", JSON.stringify(run.events, null, 2)),
      );
      history.append(item);
    }
    history.append(
      button("Delete records and suggestions", () => act("clear")),
    );
  }
  globalThis.WiekExperiencePanel = {
    mount(target, dispatch) {
      root = target;
      root.classList.add("experience-panel");
      invoke = dispatch;
      render();
    },
    update,
    destroy() {
      root = null;
    },
  };
})();
