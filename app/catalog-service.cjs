'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
function createCatalogService({ dataDir, projects = () => [], homeDir = os.homedir() }) {
  const stateFile = path.join(dataDir, 'catalog.json');
  let state = { disabled: [], selections: {} }, entries = new Map();
  if (fs.existsSync(stateFile)) { if (fs.lstatSync(stateFile).isSymbolicLink()) throw new Error('Catalog state must not be a symlink'); state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
  function save() { const temp = `${stateFile}.${crypto.randomUUID()}`; fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, stateFile); }
  function scan(projectId) {
    const project = projectId ? projects().find(p => p.id === projectId) : undefined;
    if (projectId && !project) throw new Error('Project not found');
    const roots = [];
    for (const base of [homeDir, ...(project ? [project.path] : [])]) for (const host of ['.agents','.codex','.claude']) for (const kind of ['skills','commands','agents']) roots.push({ directory: path.join(base, host, kind), kind, scope: base === homeDir ? 'user' : 'project' });
    const seen = new Set(), found = [];
    for (const { directory, kind, scope } of roots) {
      let children; try { children = fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)); } catch { continue; }
      for (const child of children.slice(0, 500)) {
        if (child.name.startsWith('.')) continue;
        const candidate = path.join(directory, child.name, kind === 'skills' ? 'SKILL.md' : '');
        let file; try { file = fs.realpathSync(kind === 'skills' ? candidate : path.join(directory, child.name)); const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 256 * 1024 || (kind !== 'skills' && !file.endsWith('.md'))) continue; } catch { continue; }
        if (seen.has(file)) continue; seen.add(file);
        const content = fs.readFileSync(file, 'utf8');
        const name = content.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || (kind === 'skills' ? child.name : child.name.replace(/\.md$/, ''));
        const description = content.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || content.split('\n').find(l => l && !l.startsWith('#') && l !== '---') || '';
        const id = crypto.createHash('sha256').update(file).digest('hex').slice(0, 24);
        const entry = { id, kind, name, description: description.slice(0, 500), scope, path: file, disabled: state.disabled.includes(id) };
        found.push(entry); entries.set(id, entry);
      }
    }
    return found;
  }
  function read(id) { const entry = entries.get(id); if (!entry) throw new Error('Refresh the catalog before opening this entry'); const stat = fs.lstatSync(entry.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || fs.realpathSync(entry.path) !== entry.path) throw new Error('Catalog entry changed, is unavailable or too large; refresh the catalog'); return { ...entry, content: fs.readFileSync(entry.path, 'utf8') }; }
  function snapshot(projectId) { return { entries: scan(projectId), selections: JSON.parse(JSON.stringify(state.selections)), limitPerRoot: 500 }; }
  async function dispatch(action, payload = {}) {
    if (action === 'catalog:list') return snapshot(payload.projectId);
    if (action === 'catalog:read') return read(payload.id);
    if (action === 'catalog:toggle') { if (!entries.has(payload.id)) throw new Error('Catalog entry not found'); state.disabled = state.disabled.includes(payload.id) ? state.disabled.filter(id => id !== payload.id) : [...state.disabled, payload.id]; save(); return snapshot(payload.projectId); }
    if (action === 'catalog:select') {
      const available = new Set(scan(payload.projectId).map(entry => entry.id));
      if (typeof payload.threadId !== 'string' || !payload.threadId || !Array.isArray(payload.ids) || payload.ids.length > 8 || payload.ids.some(id => !available.has(id) || state.disabled.includes(id))) throw new Error('Select up to eight available enabled catalog entries in this project scope for a thread');
      state.selections[payload.threadId] = [...new Set(payload.ids)]; save(); return snapshot(payload.projectId);
    }
    throw new Error(`Unknown catalog action: ${action}`);
  }
  function promptForThread(thread) {
    const available = new Set(scan(thread.projectId).map(entry => entry.id));
    let prompt = '';
    for (const id of state.selections[thread.id] || []) {
      if (state.disabled.includes(id) || !available.has(id)) continue;
      const entry = entries.get(id); if (!entry) continue;
      // A project-specific selection must remain within its originating project.
      const project = projects().find(p => p.id === thread.projectId);
      if (entry.scope === 'project' && (!project || !entry.path.startsWith(fs.realpathSync(project.path) + path.sep))) continue;
      const content = read(id).content;
      const section = `\n\nUser-selected ${entry.kind}: ${entry.name}\nSource: ${entry.path}\n${content}`;
      if (Buffer.byteLength(prompt + section, 'utf8') > 12000) throw new Error('Selected skill instructions exceed the 12000 byte agent context limit');
      prompt += section;
    }
    return prompt;
  }
  return { dispatch, snapshot, promptForThread };
}
module.exports = { createCatalogService };
