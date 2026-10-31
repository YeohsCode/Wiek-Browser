'use strict';
(() => {
  let root, invoke, state = { sessions: [], recording: false }, selectedId, selectedEventId, preview = null, deletedView = false, busy = false, failure = '';
  const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const button = (label, callback, cls = '') => { const node = element('button', label, `vr-button ${cls}`); node.type = 'button'; node.disabled = busy; node.onclick = callback; return node; };
  const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
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
    if (!root?.isConnected) return;
    root.classList.add('vek-recorder-panel'); root.replaceChildren();
    const head = element('header', undefined, 'vr-header'); const title = element('div'); title.append(element('h1', 'Action recorder'), element('p', 'Record a selected page’s clicks, navigation keys, and scrolls with local screenshots.'));
    const controls = element('div', undefined, 'vr-actions'); controls.append(element('span', state.recording ? '● Recording current target' : 'Recording is off', state.recording ? 'vr-recording' : 'vr-off'), button(state.recording ? 'Stop recording' : 'Start recording current page', () => action(state.recording ? 'recorder:stop' : 'recorder:start'), state.recording ? 'vr-stop' : 'vr-primary')); head.append(title, controls); root.append(head);
    root.append(element('p', 'Only the page selected at start is recorded while it remains current. Typed text, password/payment field events, clipboard contents, URL query strings, and fragments are excluded. Screenshots can contain visible page data and are kept locally until you delete or export the recording.', 'vr-notice'));
    if (failure) { const node = element('p', failure, 'vr-error'); node.setAttribute('role', 'alert'); root.append(node); }
    const layout = element('div', undefined, 'vr-layout'), rail = element('aside', undefined, 'vr-rail');
    rail.append(button(deletedView ? 'Show recordings' : 'Show deleted recordings', () => { deletedView = !deletedView; render(); }));
    const recordings = [...state.sessions].filter(item => !!item.deletedAt === deletedView).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const item of recordings) {
      const row = button('', () => chooseSession(item.id), `vr-session ${item.id === selectedId ? 'is-active' : ''}`);
      row.append(element('strong', item.name), element('small', `${(item.events || []).length} actions · ${item.status}`), element('small', when(item.startedAt))); rail.append(row);
    }
    if (!recordings.length) rail.append(element('p', deletedView ? 'No deleted recordings.' : 'No recordings yet. Recording is off by default.', 'vr-hint'));
    layout.append(rail);
    const main = element('section', undefined, 'vr-main'), current = session();
    if (!current) main.append(element('div', 'Start a recording on the page you want to inspect.', 'vr-empty'));
    else {
      const heading = element('div', undefined, 'vr-session-heading'), info = element('div'); info.append(element('h2', current.name), element('p', current.url || 'No URL metadata'), element('p', `${current.title || ''} · ${current.status}${current.stopReason ? ` · ${current.stopReason}` : ''}`));
      const actions = element('div', undefined, 'vr-actions'); actions.append(button('Export native JSON', () => action('recorder:file:export', { id: current.id })), button(current.deletedAt ? 'Restore recording' : 'Delete recording', () => action(current.deletedAt ? 'recorder:restore' : 'recorder:delete', { id: current.id }), current.deletedAt ? '' : 'vr-danger')); heading.append(info, actions); main.append(heading);
      const stats = element('p', `${(current.events || []).length}/${state.limits?.maxEvents || 200} actions · ${(Number(current.imageBytes || 0) / 1048576).toFixed(2)} MiB of screenshots · ${(Number(state.limits?.maxTotalImageBytes || 52428800) / 1048576).toFixed(0)} MiB per session maximum`, 'vr-hint'); main.append(stats);
      if (current.deletedAt) main.append(element('p', 'Soft deleted. The local recording and screenshots remain recoverable.', 'vr-notice'));
      const content = element('div', undefined, 'vr-content'), timeline = element('ol', undefined, 'vr-timeline'); timeline.setAttribute('aria-label', 'Recorded actions');
      for (const event of current.events || []) {
        const row = element('li'), select = button('', () => chooseEvent(event), `vr-event ${event.id === selectedEventId ? 'is-active' : ''}`);
        select.append(element('strong', describe(event)), element('code', event.selector || (event.box ? 'Element geometry recorded' : 'Page action')), element('small', `${when(event.at)} · ${event.screenshotStatus || 'No screenshot'}`)); row.append(select); timeline.append(row);
      }
      if (!(current.events || []).length) timeline.append(element('li', current.status === 'recording' ? 'Waiting for a supported action on the recorded page…' : 'No supported actions were captured.', 'vr-hint'));
      const viewer = element('section', undefined, 'vr-preview'); viewer.setAttribute('aria-label', 'Recorded screenshot preview');
      const event = (current.events || []).find(item => item.id === selectedEventId);
      if (event) {
        viewer.append(element('h3', describe(event)));
        if (preview?.eventId === event.id) { const image = element('img'); image.alt = 'Screenshot captured after the recorded action'; image.src = preview.source; viewer.append(image); }
        else viewer.append(element('p', event.image ? 'Loading recorded screenshot…' : `No screenshot: ${event.screenshotStatus || 'not captured'}.`, 'vr-hint'));
        if (event.box) viewer.append(element('code', `Element box · x ${event.box.x}, y ${event.box.y}, width ${event.box.width}, height ${event.box.height}`));
        viewer.append(element('p', event.url, 'vr-hint'));
      } else viewer.append(element('div', 'Choose an action to inspect its screenshot and element box.', 'vr-empty'));
      content.append(timeline, viewer); main.append(content);
    }
    layout.append(main); root.append(layout);
  }
  window.VekRecorderPanel = { mount(target, dispatch) { root = target; invoke = dispatch; render(); }, update(next) { apply(next); render(); } };
})();
