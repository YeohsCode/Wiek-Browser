'use strict';

const frameSessions = new Map();

// The public SDK consumes the documented native {content, refs} contract. This
// implementation obtains node identity from Chromium, never from page selectors.
// AX supplies semantics; DOMSnapshot supplies frame-local identity and layout.
async function snapshotPage({ sendCDP: send, targetId, options = {}, sessionId }) {
  const scope = options.scope || 'full_page';
  if (!['full_page', 'only_within_viewport', 'subtree'].includes(scope)) throw snapshotError('Invalid snapshot scope');
  if (scope === 'subtree' && !Number.isInteger(options.root)) throw snapshotError('Subtree snapshot requires a backendNodeId root');
  const frames = new Map();
  const sessions = new Map([[targetId, sessionId]]);
  const ingest = (tree, sid, parentId) => {
    if (!tree?.frame) return;
    const old = frames.get(tree.frame.id);
    frames.set(tree.frame.id, { ...old, ...tree.frame, parentId: tree.frame.parentId || parentId || old?.parentId, sessionId: sid });
    for (const child of tree.childFrames || []) ingest(child, sid, tree.frame.id);
  };
  const mainTree = await send('Page.getFrameTree', {}, sessionId);
  ingest(mainTree.frameTree, sessionId);
  const mainFrameId = mainTree.frameTree.frame.id;
  // An OOPIF owns a different renderer and debugger session. Its backend ids
  // must never be resolved in the top-level renderer.
  const targetInfos = (await send('Target.getTargets', {}, sessionId)).targetInfos || [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of targetInfos) {
      if (target.type !== 'iframe' || sessions.has(target.targetId)) continue;
      if (!frames.has(target.targetId) && !sessions.has(target.parentId) && !frames.has(target.parentId) && !frames.has(target.parentFrameId)) continue;
      const key = `${sessionId || targetId}:${target.targetId}`;
      let childSessionId = frameSessions.get(key);
      let tree;
      if (childSessionId) {
        try { tree = await send('Page.getFrameTree', {}, childSessionId); }
        catch { frameSessions.delete(key); childSessionId = undefined; }
      }
      if (!childSessionId) {
        const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, sessionId);
        childSessionId = attached.sessionId;
        if (frameSessions.size > 1024) frameSessions.clear();
        frameSessions.set(key, childSessionId);
        tree = await send('Page.getFrameTree', {}, childSessionId);
      }
      sessions.set(target.targetId, childSessionId);
      ingest(tree.frameTree, childSessionId, target.parentFrameId || target.parentId);
      changed = true;
    }
  }
  const documents = new Map();
  const layouts = await Promise.all([...new Set(sessions.values())].map(async (sid) => {
    const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true }, sid);
    return { sid, snapshot };
  }));
  for (const { sid, snapshot } of layouts) {
    const strings = snapshot.strings || [];
    for (const document of snapshot.documents || []) {
      const frameId = strings[document.frameId];
      const nodes = new Map();
      const list = [];
      const source = document.nodes;
      const bounds = new Map((document.layout?.nodeIndex || []).map((index, i) => [index, document.layout.bounds[i]]));
      for (let index = 0; index < source.backendNodeId.length; index++) {
        const attrValues = source.attributes?.[index] || [];
        const attrs = {};
        for (let i = 0; i < attrValues.length; i += 2) attrs[strings[attrValues[i]]] = strings[attrValues[i + 1]];
        const node = { backendNodeId: source.backendNodeId[index], tag: strings[source.nodeName[index]]?.toLowerCase(), type: source.nodeType[index], attrs, bounds: bounds.get(index), parentIndex: source.parentIndex[index], index };
        nodes.set(node.backendNodeId, node);
        list.push(node);
      }
      const doc = { frameId, sessionId: sid, nodes, list, scrollX: document.scrollOffsetX || 0, scrollY: document.scrollOffsetY || 0, contentDocuments: source.contentDocumentIndex, sourceDocuments: snapshot.documents, strings };
      documents.set(frameId, doc);
      // Capture also discovers same-process nested frames omitted by some
      // Page.getFrameTree versions.
      if (!frames.has(frameId)) frames.set(frameId, { id: frameId, sessionId: sid });
    }
  }
  for (const doc of documents.values()) {
    const contentDocs = doc.contentDocuments;
    for (let i = 0; i < (contentDocs?.index?.length || 0); i++) {
      const childId = doc.strings[doc.sourceDocuments[contentDocs.value[i]].frameId];
      const frame = frames.get(childId);
      if (frame) { frame.parentId = doc.frameId; frame.owner = doc.list[contentDocs.index[i]]; }
    }
  }
  for (const frame of frames.values()) {
    if (frame.id === mainFrameId || frame.owner) continue;
    const parent = frames.get(frame.parentId) || frames.get(mainFrameId);
    try {
      const owner = await send('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
      frame.owner = documents.get(parent.id)?.nodes.get(owner.backendNodeId);
    } catch { /* Detached frames have no live owner and are excluded below. */ }
  }
  const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  for (const frame of frames.values()) {
    const doc = documents.get(frame.id);
    if (!doc) continue;
    frame.width = frame.id === mainFrameId ? viewport.clientWidth : frame.owner?.bounds?.[2];
    frame.height = frame.id === mainFrameId ? viewport.clientHeight : frame.owner?.bounds?.[3];
    const tree = await send('Accessibility.getFullAXTree', { frameId: frame.id }, frame.sessionId);
    frame.ax = new Map((tree.nodes || []).map((node) => [node.nodeId, node]));
    frame.axRoots = (tree.nodes || []).filter((node) => !node.parentId || !frame.ax.has(node.parentId));
    frame.byBackend = new Map((tree.nodes || []).filter((node) => node.backendDOMNodeId).map((node) => [node.backendDOMNodeId, node]));
  }
  const children = new Map();
  for (const frame of frames.values()) {
    if (frame.owner && frame.parentId) {
      const key = `${frame.parentId}:${frame.owner.backendNodeId}`;
      children.set(key, frame);
    }
  }
  const intersects = (node, frame) => {
    if (!node?.bounds) return false;
    const doc = documents.get(frame.id);
    const [x, y, w, h] = node.bounds;
    return w > 0 && h > 0 && x + w > doc.scrollX && y + h > doc.scrollY && x < doc.scrollX + frame.width && y < doc.scrollY + frame.height;
  };
  const refs = [];
  let refCounter = 0;
  const render = (ax, frame, force = false, visited = new Set()) => {
    if (!ax || visited.has(ax.nodeId)) return [];
    visited.add(ax.nodeId);
    const doc = documents.get(frame.id);
    const node = doc?.nodes.get(ax.backendDOMNodeId);
    let role = normalizeRole(ax.role?.value);
    const name = String(ax.name?.value || '').replace(/[\s\u200b-\u200f\ufeff]+/g, ' ').trim();
    const skipHidden = ax.ignored && (ax.ignoredReasons || []).some((reason) => ['notRendered', 'ariaHiddenElement', 'ariaHiddenSubtree', 'inertElement', 'inertSubtree'].includes(reason.name));
    if (skipHidden) return [];
    const childFrame = node && children.get(`${frame.id}:${node.backendNodeId}`);
    if (childFrame) role = 'iframe';
    const viewportScope = scope === 'only_within_viewport';
    const visible = !viewportScope || intersects(node, frame);
    if (role === 'iframe' && !visible) return [];
    let descendants = (ax.childIds || []).flatMap((id) => render(frame.ax.get(id), frame, force, visited));
    if (childFrame && (!viewportScope || visible)) {
      descendants = childFrame.axRoots.flatMap((root) => render(root, childFrame, true));
    }
    if (role === 'inline_text_box') return [];
    if (ax.ignored && !childFrame) return descendants;
    if (role === 'text' && !name.replace(/[\s\p{Cf}]/gu, '')) return [];
    if (viewportScope && !visible && descendants.length === 0 && role !== 'root') return [];
    const interactive = isInteractive(role, node);
    if (options.interactiveOnly && !interactive && role !== 'root' && role !== 'iframe') return descendants;
    if (['container', 'none', 'unknown'].includes(role) && !name) {
      if (!descendants.length) return [];
      if (descendants.length === 1) return descendants;
      role = 'container';
    }
    const text = role + (name && role !== 'root' ? ` ${JSON.stringify(name)}` : '');
    const props = [];
    if (role === 'link' && node?.attrs.href) props.push(`url=${JSON.stringify(node.attrs.href)}`);
    if (ax.value?.value !== undefined) props.push(`value=${JSON.stringify(ax.value.value)}`);
    if (options.includeActionMarks !== false) {
      for (const property of ax.properties || []) {
        if (['checked', 'selected', 'expanded', 'disabled', 'required', 'level', 'pressed', 'readonly'].includes(property.name) && property.value?.value !== false) props.push(`${property.name}=${JSON.stringify(property.value?.value)}`);
      }
    }
    const refBearing = node && node.type === 1 && role !== 'root' && role !== 'text' && (role !== 'container' || name || interactive);
    if (refBearing) {
      const ref = { refId: ++refCounter, backendNodeId: node.backendNodeId, role, name, ...(frame.id !== mainFrameId ? { frameId: frame.id } : {}), frameProvenance: frame.id === mainFrameId ? 'page' : 'frame', sessionId: frame.sessionId };
      if (options.includeStableLocator) {
        const loc = stableLocator(node, doc);
        if (loc) ref.loc = loc;
      }
      refs.push(ref);
      props.unshift(`ref=${ref.refId}${ref.loc ? `, loc=${ref.loc}` : ''}`);
    }
    return [{ text: text + (props.length ? ` [${props.join(', ')}]` : ''), children: descendants }];
  };
  let output;
  if (scope === 'subtree') {
    const candidates = [...frames.values()].filter((frame) => frame.byBackend?.has(options.root));
    if (!candidates.length) throw snapshotError('Subtree root was not found; take a fresh snapshot');
    if (candidates.length > 1) throw snapshotError('Subtree root is ambiguous across frames');
    const frame = candidates[0];
    output = render(frame.byBackend.get(options.root), frame, true);
  } else {
    const frame = frames.get(mainFrameId);
    output = frame.axRoots.flatMap((root) => render(root, frame));
  }
  const lines = [];
  const flatten = (nodes, depth) => {
    for (const node of nodes) { lines.push('  '.repeat(depth) + node.text); flatten(node.children, depth + 1); }
  };
  flatten(output, 0);
  let content = lines.join('\n');
  if (options.maxResultLength > 0 && content.length > options.maxResultLength) {
    content = content.slice(0, options.maxResultLength);
    const printed = new Set([...content.matchAll(/\[ref=(\d+)(?=[,\]])/g)].map((match) => Number(match[1])));
    return { content, refs: refs.filter((ref) => printed.has(ref.refId)) };
  }
  return { content, refs };
}

function normalizeRole(role = '') {
  const roles = { RootWebArea: 'root', WebArea: 'root', StaticText: 'text', InlineTextBox: 'inline_text_box', Iframe: 'iframe', IframePresentational: 'iframe', generic: 'container', none: 'container', image: 'image', SvgRoot: 'svg_root', Canvas: 'canvas' };
  return roles[role] || role.toLowerCase() || 'container';
}

function isInteractive(role, node) {
  return /^(button|link|textbox|combobox|checkbox|radio|switch|slider|spinbutton|listbox|option|menuitem|tab|treeitem|searchbox)$/.test(role) || node?.attrs.contenteditable === 'true' || node?.attrs.tabindex !== undefined;
}

function stableLocator(node, doc) {
  const attrs = node.attrs;
  // A duplicated href is deliberately not replaced with a different hint: the
  // href itself is page content and must not look reusable when it is ambiguous.
  if (node.tag === 'a' && attrs.href) return doc.list.filter((n) => n.tag === 'a' && n.attrs.href === attrs.href).length === 1 ? `href:${attrs.href}` : undefined;
  if (attrs.id && /^[-_a-zA-Z][-_a-zA-Z0-9]*$/.test(attrs.id) && doc.list.filter((n) => n.attrs.id === attrs.id).length === 1) return `css:#${attrs.id}`;
  if (attrs['aria-label'] && doc.list.filter((n) => n.tag === node.tag && n.attrs['aria-label'] === attrs['aria-label']).length === 1) return `css:${node.tag}[aria-label=${JSON.stringify(attrs['aria-label'])}]`;
  // AX omits hidden copies, so AX role/name uniqueness alone is insufficient
  // evidence that a role locator is unique in the DOM. Omit that optional hint.
  return undefined;
}

function snapshotError(message) {
  const error = new Error(message);
  error.error_code = 'WIEK_SNAPSHOT_FAILED';
  return error;
}

module.exports = { snapshotPage, createSnapshot: ({ send, ...rest }) => snapshotPage({ sendCDP: send, ...rest }) };
