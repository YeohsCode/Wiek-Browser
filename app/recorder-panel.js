'use strict';

(() => {
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  let root, invoke, state = { sessions: [], recording: false }, selectedId, selectedEventId, preview = null, deletedView = false, busy = false, failure = '';
  const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const button = (label, callback, cls = '') => { const node = element('button', label, `vr-button ${cls}`); node.type = 'button'; node.disabled = busy; node.onclick = callback; return node; };
  const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(globalThis.WiekI18n?.locale()) : '—';
  const session = () => state.sessions.find(item => item.id === selectedId);
  function apply(next) {
    const data = next?.recorder || next?.recordings || next;
    if (Array.isArray(data?.sessions)) state = { ...data, sessions: [...data.sessions] };
    else if (data?.id && Array.isArray(data.events)) {
      state.sessions = state.sessions.map(item => item.id === data.id ? data : item);
      if (data.preview?.eventId && /^[A-Za-z0-9+/]*={0,2}$/.test(data.preview.pngBase64 || '')) preview = { eventId: data.preview.eventId, source: `data:image/png;base64,${data.preview.pngBase64}` };
    }
    if (!state.sessions.some(item => item.id === selectedId)) selectedId = state.activeSessionId || state.sessions.find(item => !item.deletedAt)?.id || state.sessions[0]?.id;
  }
  async function action(name, payload = {}) {
    if (busy) return; busy = true; failure = ''; render();
    try { const result = await invoke(name, payload); if (result?.error) throw new Error(result.error); apply(result); if (name === 'recorder:start' && state.activeSessionId) { selectedId = state.activeSessionId; selectedEventId = null; preview = null; } return result; }
    catch (error) { failure = error.message || String(error); }
    finally { busy = false; render(); }
  }
  async function chooseSession(id) { selectedId = id; selectedEventId = null; preview = null; render(); await action('recorder:read', { id }); }
  async function chooseEvent(event) { selectedEventId = event.id; preview = null; render(); if (event.image) await action('recorder:read', { id: selectedId, eventId: event.id }); }
  function describe(event) {
    if (event.kind === 'key') return [...(event.modifiers || []), event.key].join(' + ');
    if (event.kind === 'scroll') return `Scroll · ${event.deltaX || 0}, ${event.deltaY || 0}`;
    return `Click${event.x !== undefined ? ` · ${Math.round(event.x)}, ${Math.round(event.y)}` : ''}`;
  }
  function render() {
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;
    if (!root?.isConnected) return;
    root.classList.add('vek-recorder-panel'); root.replaceChildren();
    const head = element('header', undefined, 'vr-header'); const title = element('div'); title.append(element('h1', tr("Page action history")), element('p', tr("Record a selected page’s clicks, navigation keys, and scrolls with local screenshots.")));
    const controls = element('div', undefined, 'vr-actions'); controls.append(element('span', state.recording ? tr("● Recording current target") : tr("Recording is off"), state.recording ? 'vr-recording' : 'vr-off'), button(state.recording ? tr("Stop recording") : tr("Start recording current page"), () => action(state.recording ? 'recorder:stop' : 'recorder:start'), state.recording ? 'vr-stop' : 'vr-primary')); head.append(title, controls); root.append(head);
    root.append(element('p', tr("Only the page selected at start is recorded while it remains current. Typed text, password/payment field events, clipboard contents, URL query strings, and fragments are excluded. Screenshots can contain visible page data and are kept locally until you delete or export the recording."), 'vr-notice'));
    if (failure) { const node = element('p', (globalThis.WiekI18n?.error(failure) ?? (failure)), 'vr-error'); node.setAttribute('role', 'alert'); root.append(node); }
    const layout = element('div', undefined, 'vr-layout'), rail = element('aside', undefined, 'vr-rail');
    rail.append(button(deletedView ? tr("Show recordings") : tr("Show deleted recordings"), () => { deletedView = !deletedView; render(); }));
    const recordings = [...state.sessions].filter(item => !!item.deletedAt === deletedView).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const item of recordings) {
      const row = button('', () => chooseSession(item.id), `vr-session ${item.id === selectedId ? 'is-active' : ''}`);
      row.append(element('strong', item.name), element('small', tr("{0} actions · {1}", ((item.events || []).length), (item.status))), element('small', when(item.startedAt))); rail.append(row);
    }
    if (!recordings.length) rail.append(element('p', deletedView ? tr("No deleted recordings.") : tr("No recordings yet. Recording is off by default."), 'vr-hint'));
    layout.append(rail);
    const main = element('section', undefined, 'vr-main'), current = session();
    if (!current) main.append(element('div', tr("Start a recording on the page you want to inspect."), 'vr-empty'));
    else {
      const heading = element('div', undefined, 'vr-session-heading'), info = element('div'); info.append(element('h2', current.name), element('p', current.url || tr("No URL metadata")), element('p', `${current.title || ''} · ${current.status}${current.stopReason ? ` · ${current.stopReason}` : ''}`));
      const actions = element('div', undefined, 'vr-actions'); actions.append(button(tr("Export action history (JSON)"), () => action('recorder:file:export', { id: current.id })), button(current.deletedAt ? tr("Restore recording") : tr("Delete recording"), () => action(current.deletedAt ? 'recorder:restore' : 'recorder:delete', { id: current.id }), current.deletedAt ? '' : 'vr-danger')); heading.append(info, actions); main.append(heading);
      const stats = element('p', tr("{0}/{1} actions · {2} MiB of screenshots · {3} MiB per session maximum", ((current.events || []).length), (state.limits?.maxEvents || 200), ((Number(current.imageBytes || 0) / 1048576).toFixed(2)), ((Number(state.limits?.maxTotalImageBytes || 52428800) / 1048576).toFixed(0))), 'vr-hint'); main.append(stats);
      if (current.deletedAt) main.append(element('p', tr("Soft deleted. The local recording and screenshots remain recoverable."), 'vr-notice'));
      const content = element('div', undefined, 'vr-content'), timeline = element('ol', undefined, 'vr-timeline'); timeline.setAttribute('aria-label', tr("Recorded actions"));
      for (const event of current.events || []) {
        const row = element('li'), select = button('', () => chooseEvent(event), `vr-event ${event.id === selectedEventId ? 'is-active' : ''}`);
        select.append(element('strong', describe(event)), element('code', event.selector || (event.box ? tr("Element geometry recorded") : tr("Page action"))), element('small', `${when(event.at)} · ${event.screenshotStatus || 'No screenshot'}`)); row.append(select); timeline.append(row);
      }
      if (!(current.events || []).length) timeline.append(element('li', current.status === 'recording' ? tr("Waiting for a supported action on the recorded page…") : tr("No supported actions were captured."), 'vr-hint'));
      const viewer = element('section', undefined, 'vr-preview'); viewer.setAttribute('aria-label', tr("Recorded screenshot preview"));
      const event = (current.events || []).find(item => item.id === selectedEventId);
      if (event) {
        viewer.append(element('h3', describe(event)));
        if (preview?.eventId === event.id) { const image = element('img'); image.alt = tr("Screenshot captured after the recorded action"); image.src = preview.source; viewer.append(image); }
        else viewer.append(element('p', event.image ? tr("Loading recorded screenshot…") : tr("No screenshot: {0}.", (event.screenshotStatus || 'not captured')), 'vr-hint'));
        if (event.box) viewer.append(element('code', tr("Element box · x {0}, y {1}, width {2}, height {3}", (event.box.x), (event.box.y), (event.box.width), (event.box.height))));
        viewer.append(element('p', event.url, 'vr-hint'));
      } else viewer.append(element('div', tr("Choose an action to inspect its screenshot and element box."), 'vr-empty'));
      content.append(timeline, viewer); main.append(content);
    }
    layout.append(main); root.append(layout);
  }
  window.WiekRecorderPanel = { mount(target, dispatch) { root = target; invoke = dispatch; render(); }, update(next) { apply(next); render(); } };
})();
