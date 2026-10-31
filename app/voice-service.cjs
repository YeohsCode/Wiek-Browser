'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
function createVoiceService({ dataDir, maxAudioBytes = 20 * 1024 * 1024, timeoutMs = 120000, defaultConfig = null }) {
  const file = path.join(dataDir, 'voice.json');
  const settingsFile = path.join(dataDir, 'voice-settings.json'), historyFile = path.join(dataDir, 'voice-history.json');
  let config = defaultConfig, running = null, activeWork = null, closed = false;
  if (fs.existsSync(file)) { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Voice config must not be a symlink'); config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  function readJSON(file, fallback) { if (!fs.existsSync(file)) return fallback; if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Voice state must not be a symlink'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  function writeJSON(file, value) { const temp = `${file}.${randomUUID()}`; fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  let preferences = { language:'auto', historyRetentionDays:7, keepAudio:false, sounds:false, muteOtherAudio:true, dictionary:[], ...readJSON(settingsFile, {}) };
  let history = readJSON(historyFile, []);
  function prune() {
    const cutoff = Date.now() - preferences.historyRetentionDays * 86400000;
    const expired = history.filter(row => !preferences.historyRetentionDays || Date.parse(row.createdAt) < cutoff);
    for (const row of expired) try { fs.unlinkSync(path.join(dataDir, 'voice-recordings', `${row.id}.audio`)); } catch {}
    if (expired.length) { history = history.filter(row => !expired.includes(row)); writeJSON(historyFile, history); }
  }
  prune();
  function snapshot() { prune(); return { configured: Boolean(config), config, settings:JSON.parse(JSON.stringify(preferences)), history:JSON.parse(JSON.stringify(history)), running: Boolean(running), maxAudioBytes, capability: 'local-cli' }; }
  function correct(text) { for (const entry of [...preferences.dictionary].sort((a,b)=>b.from.length-a.from.length)) text = text.split(entry.from).join(entry.to); return text; }
  function stop() {
    const child = running; if (!child) return; child.vekStopped = true;
    const kill = signal => { try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    kill('SIGTERM'); const force = setTimeout(() => { if (child.exitCode === null && !child.signalCode) kill('SIGKILL'); }, 1000); force.unref?.(); child.once('close', () => clearTimeout(force));
  }
  async function dispatch(action, payload = {}) {
    if (action === 'voice:snapshot') return snapshot();
    if (closed) throw new Error('Voice service is closed');
    if (action === 'voice:stop') { stop(); return snapshot(); }
    if (action === 'voice:settings:update') {
      const next = {...preferences};
      if (payload.language !== undefined) { if (!/^(auto|[a-z]{2,3})$/.test(payload.language)) throw new Error('Use auto or a language code such as en or zh'); next.language=payload.language; }
      if (payload.historyRetentionDays !== undefined) { if (!Number.isInteger(payload.historyRetentionDays) || payload.historyRetentionDays<0 || payload.historyRetentionDays>365) throw new Error('History retention must be from 0 to 365 days'); next.historyRetentionDays=payload.historyRetentionDays; }
      for (const key of ['keepAudio','sounds','muteOtherAudio']) if (payload[key] !== undefined) { if (typeof payload[key] !== 'boolean') throw new Error(`${key} must be true or false`); next[key]=payload[key]; }
      if (payload.dictionary !== undefined) {
        if (!Array.isArray(payload.dictionary) || payload.dictionary.length>200 || payload.dictionary.some(entry=>!entry || typeof entry.from!=='string' || !entry.from || entry.from.length>200 || typeof entry.to!=='string' || entry.to.length>500)) throw new Error('Dictionary supports up to 200 literal phrase replacements');
        next.dictionary=payload.dictionary.map(({from,to})=>({from,to}));
      }
      writeJSON(settingsFile,next); preferences=next; prune(); return snapshot();
    }
    if (action === 'voice:history:list') { prune(); return snapshot(); }
    if (['voice:history:delete','voice:history:restore','voice:history:audio'].includes(action)) {
      const entry=history.find(row=>row.id===payload.id); if (!entry) throw new Error('Voice history item not found');
      if (action==='voice:history:audio') { if (!entry.hasAudio) throw new Error('Audio was not retained for this item'); return {mime:entry.mime,base64:fs.readFileSync(path.join(dataDir,'voice-recordings',`${entry.id}.audio`)).toString('base64')}; }
      entry.trashed=action.endsWith(':delete');writeJSON(historyFile,history);return snapshot();
    }
    if (action === 'voice:configure') {
      if (running) throw new Error('Stop transcription before changing its provider');
      let candidate;
      if (payload.disabled) candidate = null;
      else {
        if (typeof payload.command !== 'string' || !path.isAbsolute(payload.command) || !Array.isArray(payload.args) || payload.args.some(a => typeof a !== 'string' || a.includes('\0')) || !payload.args.some(a => a.includes('{audio}'))) throw new Error('Configure an absolute executable path and argument array containing {audio}');
        fs.accessSync(payload.command, fs.constants.X_OK);
        candidate = { command: payload.command, args: payload.args, output: payload.output === 'file' ? 'file' : 'stdout' };
        if (candidate.output === 'file' && !candidate.args.some(a => a.includes('{output}'))) throw new Error('File output requires an {output} placeholder');
      }
      const temp = `${file}.${randomUUID()}`; fs.writeFileSync(temp, JSON.stringify(candidate), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); config = candidate; return snapshot();
    }
    if (action !== 'voice:transcribe') throw new Error(`Unknown voice action: ${action}`);
    if (!config) throw new Error('Configure a local transcription CLI in Voice settings first');
    if (running) throw new Error('A transcription is already running');
    const bytes = typeof payload.base64 === 'string' ? Buffer.from(payload.base64,'base64') : Buffer.from(payload.audio || []);
    if (!bytes.length || bytes.length > maxAudioBytes) throw new Error('Audio must be nonempty and at most 20 MiB');
    const extension = ({ 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' })[payload.mime];
    if (!extension) throw new Error('Unsupported audio type');
    const directory = path.join(dataDir, 'voice-tmp', randomUUID()); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const audio = path.join(directory, `recording.${extension}`), output = path.join(directory, 'transcript.txt');
    fs.writeFileSync(audio, bytes, { flag: 'wx', mode: 0o600 });
    const settings = { ...config }, args = settings.args.map(a => a.replaceAll('{audio}', audio).replaceAll('{output}', output).replaceAll('{language}', preferences.language));
    let work, child;
    try {
      work = new Promise((resolve, reject) => {
        child = spawn(settings.command, args, { cwd: directory, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); running = child;
        let stdout = '', stderr = '', size = 0, timedOut = false;
        const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        const consume = (name, chunk) => { size += chunk.length; if (size > 1024 * 1024) { stop(); return; } if (name === 'stdout') stdout += stdoutDecoder.write(chunk); else stderr += stderrDecoder.write(chunk); };
        child.stdout.on('data', chunk => consume('stdout', chunk)); child.stderr.on('data', chunk => consume('stderr', chunk));
        child.once('error', error => { clearTimeout(timer); reject(new Error(`Transcription could not start: ${error.code || 'process error'}`)); });
        child.once('close', (code, signal) => {
          stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
          clearTimeout(timer);
          if (timedOut || child.vekStopped || code !== 0 || signal || size > 1024 * 1024) { reject(new Error(timedOut ? 'Transcription timed out' : child.vekStopped ? 'Transcription stopped' : `Transcription failed (${signal || code}); ${Buffer.byteLength(stderr)} diagnostic bytes`)); return; }
          try {
            let text = stdout;
            if (settings.output === 'file') { const stat = fs.lstatSync(output); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid transcript output'); text = fs.readFileSync(output, 'utf8'); }
            if (!text.trim()) throw new Error('Transcription provider returned no text');
            text = correct(text.trim());
            const result = { text, provider: path.basename(settings.command) };
            if (preferences.historyRetentionDays) {
              const id=randomUUID(), entry={id,...result,mime:payload.mime,createdAt:new Date().toISOString(),language:preferences.language,hasAudio:preferences.keepAudio};
              if (preferences.keepAudio) { const target=path.join(dataDir,'voice-recordings');fs.mkdirSync(target,{recursive:true,mode:0o700});fs.writeFileSync(path.join(target,`${id}.audio`),bytes,{flag:'wx',mode:0o600}); }
              history.unshift(entry);
              if (history.length>500) { for (const old of history.splice(500)) try { fs.unlinkSync(path.join(dataDir,'voice-recordings',`${old.id}.audio`)); } catch {} }
              writeJSON(historyFile,history);result.historyId=id;
            }
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      activeWork = work;
      return await work;
    } finally { if (running === child) running = null; if (activeWork === work) activeWork = null; fs.rmSync(directory, { recursive: true, force: true }); }
  }
  async function close() { closed = true; const work = activeWork; stop(); if (work) await work.catch(() => {}); }
  return { dispatch, snapshot, close };
}
module.exports = { createVoiceService };
