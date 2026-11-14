'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fail = (message, code = 'VEK_PREFERENCES_INVALID') => Object.assign(new Error(message), { error_code: code });
const clone = value => JSON.parse(JSON.stringify(value));
const ACTIONS = [
  ['newTab', 'New tab', 'CommandOrControl+T'], ['closeTab', 'Close tab', 'CommandOrControl+W'], ['openLocation', 'Open location', 'CommandOrControl+L'], ['reload', 'Reload page', 'CommandOrControl+R'], ['find', 'Find in page', 'CommandOrControl+F'], ['back', 'Back', 'CommandOrControl+['], ['forward', 'Forward', 'CommandOrControl+]'], ['zoomIn', 'Zoom in', 'CommandOrControl+Plus'], ['zoomOut', 'Zoom out', 'CommandOrControl+-'], ['zoomReset', 'Actual size', 'CommandOrControl+0'], ['voiceInput', 'Voice input', ''], ['screenshot', 'Capture screenshot', ''], ['clip', 'Save selected text', ''], ['chat', 'Open agent chat', ''], ['switchSpace', 'Switch tab group', ''], ['spaceManager', 'Manage tab groups', ''],
].map(([id, label, defaultAccelerator]) => ({ id, label, defaultAccelerator }));
function defaults() { return { version: 1, theme: 'system', interfaceLanguage: 'system', tabLayout: 'horizontal', backgroundMode: false, onDeviceModels: true, selectionToolbar: { enabled: false, copy: true, ask: true, save: true, translate: false }, memory: { browserActivity: false, localFiles: false }, instructions: '', shortcuts: Object.fromEntries(ACTIONS.map(a => [a.id, a.defaultAccelerator])) }; }
const aliases = { cmd: 'Command', command: 'Command', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', cmdorctrl: 'CommandOrControl', commandorcontrol: 'CommandOrControl', super: 'Super', win: 'Super', windows: 'Super' };
const specialKeys = { space: 'Space', tab: 'Tab', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right', plus: 'Plus', minus: '-' };
const modifierOrder = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super'];
function normalizeAccelerator(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length > 120 || value.includes('\0')) throw fail('Shortcut must be text of at most 120 characters');
  value = value.trim(); if (!value) return '';
  if (value.endsWith('++')) value = value.slice(0, -1) + 'Plus';
  const parts = value.split('+').map(p => p.trim()); if (parts.some(p => !p)) throw fail('Shortcut contains an empty key');
  const modifiers = []; let key;
  for (const part of parts) {
    const lower = part.toLowerCase(), modifier = lower === 'meta' ? platform === 'darwin' ? 'Command' : 'Super' : aliases[lower];
    if (modifier) { if (key) throw fail('Shortcut modifiers must precede the key'); if (modifiers.includes(modifier)) throw fail('Shortcut repeats a modifier'); modifiers.push(modifier); continue; }
    if (key) throw fail('Shortcut must contain exactly one non-modifier key');
    if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
    else if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(part)) key = part.toUpperCase();
    else if (specialKeys[lower]) key = specialKeys[lower];
    else if (/^[\[\]\-=.,/\\`;' ]$/.test(part)) key = part;
    else throw fail('Unsupported shortcut key');
  }
  if (!key || !modifiers.some(m => m !== 'Shift')) throw fail('Shortcut must start with Command, Control, Alt, or Super');
  if (modifiers.includes('CommandOrControl') && modifiers.includes(platform === 'darwin' ? 'Command' : 'Control')) throw fail('Shortcut repeats the platform primary modifier');
  return [...modifierOrder.filter(m => modifiers.includes(m)), key].join('+');
}
function physicalChord(value, platform) {
  const normalized = normalizeAccelerator(value, platform); if (!normalized) return '';
  const parts = normalized.split('+'), key = parts.pop(); const physical = new Set(parts.map(p => p === 'CommandOrControl' ? platform === 'darwin' ? 'Command' : 'Control' : p));
  return [...modifierOrder.filter(m => physical.has(m)), key].join('+');
}
function createPreferencesService({ dataDir, onChange = () => {}, platform = process.platform, reservedShortcuts = [], externalShortcuts = () => [] } = {}) {
  if (!dataDir) throw fail('dataDir is required');
  const directory = path.join(path.resolve(dataDir), 'preferences'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fail('Preferences directory must not be a symlink'); fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'state.json'); let state = defaults(), closed = false;
  const reserved = (platform === 'darwin' ? [['Command+Q', 'Quit application'], ['Command+H', 'Hide application'], ['Command+M', 'Minimize window'], ['Command+Tab', 'Switch applications'], ['Command+Space', 'System search'], ['Command+Control+Q', 'Lock screen']] : [['Alt+F4', 'Close window'], ['Alt+Tab', 'Switch applications'], ['Control+Alt+Delete', 'System security'], ['Super+L', 'Lock screen']]).concat(reservedShortcuts.map(item => [item.accelerator, item.label || 'Reserved by application'])).map(([accelerator, label]) => ({ accelerator: normalizeAccelerator(accelerator, platform), label }));
  function validatePatch(patch, current = state) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('Preferences patch must be an object');
    if (Object.keys(patch).some(key => !['theme', 'interfaceLanguage', 'tabLayout', 'backgroundMode', 'onDeviceModels', 'selectionToolbar', 'memory', 'instructions'].includes(key))) throw fail('Unknown preferences field');
    const next = clone(current);
    if (patch.theme !== undefined) { if (!['light', 'dark', 'system'].includes(patch.theme)) throw fail('Unknown theme'); next.theme = patch.theme; }
    if (patch.interfaceLanguage !== undefined) {
      if (!['system', 'en', 'zh-CN'].includes(patch.interfaceLanguage)) throw fail('Unknown interface language');
      next.interfaceLanguage = patch.interfaceLanguage;
    }
    if (patch.tabLayout !== undefined) { if (!['horizontal', 'vertical'].includes(patch.tabLayout)) throw fail('Unknown tab layout'); next.tabLayout = patch.tabLayout; }
    for (const key of ['backgroundMode', 'onDeviceModels']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw fail(`${key} must be boolean`); next[key] = patch[key]; }
    for (const key of ['selectionToolbar', 'memory']) if (patch[key] !== undefined) {
      if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) throw fail(`${key} must be an object`);
      for (const [name, value] of Object.entries(patch[key])) { if (!Object.hasOwn(next[key], name) || typeof value !== 'boolean') throw fail(`Invalid ${key} preference`); next[key][name] = value; }
    }
    if (patch.instructions !== undefined) { if (typeof patch.instructions !== 'string' || patch.instructions.includes('\0') || Buffer.byteLength(patch.instructions) > 8192) throw fail('Instructions must be text up to 8 KiB'); next.instructions = patch.instructions; }
    return next;
  }
  function checkShortcut(action, accelerator, shortcuts = state.shortcuts) {
    if (!ACTIONS.some(a => a.id === action)) return { valid: false, conflicts: [], error: 'Unknown shortcut action' };
    let normalized; try { normalized = normalizeAccelerator(accelerator, platform); } catch (error) { return { valid: false, conflicts: [], error: error.message }; }
    const physical = physicalChord(normalized, platform), conflicts = [];
    if (physical) {
      for (const item of reserved) if (physicalChord(item.accelerator, platform) === physical) conflicts.push({ type: 'system', label: item.label, accelerator: item.accelerator });
      for (const item of externalShortcuts()) if (physicalChord(item.accelerator, platform) === physical) conflicts.push({ type:'global',label:item.label||'Global shortcut',accelerator:item.accelerator });
      for (const item of ACTIONS) if (item.id !== action && physicalChord(shortcuts[item.id] || '', platform) === physical) conflicts.push({ type: 'application', action: item.id, label: item.label, accelerator: shortcuts[item.id] });
    }
    return { valid: conflicts.length === 0, normalized, physicalChord: physical, conflicts, ...(conflicts.length ? { error: `Shortcut conflicts with ${conflicts.map(c => c.label).join(', ')}` } : {}) };
  }
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw fail('Preferences state must not be a symlink');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !saved.shortcuts || Object.keys(saved.shortcuts).some(key => !ACTIONS.some(a => a.id === key))) throw fail('Unsupported preferences state');
    const { version, shortcuts, ...patch } = saved; state = validatePatch(patch, defaults()); state.shortcuts = { ...state.shortcuts, ...shortcuts };
    for (const [action, accelerator] of Object.entries(state.shortcuts)) { const result = checkShortcut(action, accelerator, state.shortcuts); if (!result.valid) throw fail(`Invalid saved shortcut for ${action}: ${result.error}`); state.shortcuts[action] = result.normalized; }
  }
  function snapshot() { return clone({ ...state, actions: ACTIONS, reservedShortcuts: reserved }); }
  function publish() {
    const temporary = `${file}.${randomUUID()}.tmp`; let fd;
    try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    try { onChange(snapshot()); } catch {}
  }
  async function dispatch(action, payload = {}) {
    if (closed) throw fail('Preferences service is closed', 'VEK_PREFERENCES_CLOSED');
    if (action === 'preferences:snapshot') return snapshot();
    if (action === 'preferences:update') { const next = validatePatch(payload); state = next; publish(); return snapshot(); }
    if (action === 'preferences:shortcuts:validate') return checkShortcut(payload.action, payload.accelerator);
    if (action === 'preferences:shortcuts:set') { const result = checkShortcut(payload.action, payload.accelerator); if (!result.valid) throw fail(result.error, result.conflicts.length ? 'VEK_PREFERENCES_SHORTCUT_CONFLICT' : 'VEK_PREFERENCES_INVALID'); state.shortcuts[payload.action] = result.normalized; publish(); return snapshot(); }
    if (action === 'preferences:shortcuts:reset') { if (payload.action) { const item = ACTIONS.find(a => a.id === payload.action); if (!item) throw fail('Unknown shortcut action'); const result = checkShortcut(item.id, item.defaultAccelerator); if (!result.valid) throw fail(result.error, 'VEK_PREFERENCES_SHORTCUT_CONFLICT'); state.shortcuts[item.id] = item.defaultAccelerator; } else state.shortcuts = defaults().shortcuts; publish(); return snapshot(); }
    if (action === 'preferences:reset') { state = defaults(); publish(); return snapshot(); }
    throw fail(`Unknown preferences action: ${action}`);
  }
  publish(); return { dispatch, snapshot, checkShortcut, close() { closed = true; } };
}
module.exports = { createPreferencesService, normalizeAccelerator, physicalChord, defaults, ACTIONS };
