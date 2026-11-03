import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('real Electron recorder panel previews one requested image and wires explicit record/export/soft-delete controls', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vek-recorder-ui-'));
  const script = join(directory, 'probe.cjs'), panelPath = resolve(new URL('../app/recorder-panel.js', import.meta.url).pathname);
  const code = `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});try{
      await window.loadURL('data:text/html,<main id="root"></main>');await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(panelPath)},'utf8'));
      const result=await window.webContents.executeJavaScript('('+${JSON.stringify(async function probe() {
        const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5XQAAAAASUVORK5CYII=';
        const recording = { id: 'recording', name: '<img src=x onerror="window.attacked=true">', targetId: 'page', url: 'https://example.test/path', title: 'Recorded page', status: 'stopped', startedAt: new Date().toISOString(), imageBytes: 68, events: [{ id: 'event', kind: 'click', x: 25, y: 35, selector: '#button', box: { x: 20, y: 30, width: 50, height: 40 }, image: { id: 'png', bytes: 68 }, screenshotStatus: 'captured', at: new Date().toISOString() }] };
        const state = { sessions: [recording], recording: false, activeSessionId: null, limits: { maxEvents: 200, maxTotalImageBytes: 52428800 } }, calls = [];
        WiekRecorderPanel.mount(document.querySelector('#root'), async (name, payload) => {
          calls.push({ name, payload });
          if (name === 'recorder:read') return { ...structuredClone(recording), ...(payload.eventId ? { preview: { eventId: 'event', pngBase64 } } : {}) };
          if (name === 'recorder:start') { state.recording = true; state.activeSessionId = recording.id; recording.status = 'recording'; }
          if (name === 'recorder:stop') { state.recording = false; state.activeSessionId = null; recording.status = 'stopped'; }
          if (name === 'recorder:delete') recording.deletedAt = new Date().toISOString();
          if (name === 'recorder:restore') delete recording.deletedAt;
          return structuredClone(state);
        });
        WiekRecorderPanel.update(state);
        const literal = !document.querySelector('img') && !window.attacked && document.body.textContent.includes('<img src=x');
        const noAutoRecord = calls.length === 0;
        const click = async label => { const node = [...document.querySelectorAll('button')].find(item => item.textContent === label); if (!node) throw new Error('Missing control ' + label); node.click(); await new Promise(resolve => setTimeout(resolve, 15)); };
        document.querySelector('.vr-event').click(); await new Promise(resolve => setTimeout(resolve, 15));
        const preview = document.querySelector('.vr-preview img')?.src === 'data:image/png;base64,' + pngBase64;
        const geometry = document.body.textContent.includes('width 50, height 40');
        await click('Export native JSON'); await click('Delete recording');
        const softDeleted = document.body.textContent.includes('Soft deleted');
        await click('Restore recording'); await click('Start recording current page'); await click('Stop recording');
        return { literal, noAutoRecord, preview, geometry, softDeleted, calls, recording: state.recording };
      }.toString())}+')()');
      for(const key of ['literal','noAutoRecord','preview','geometry','softDeleted'])assert.equal(result[key],true,key);
      for(const method of ['recorder:read','recorder:file:export','recorder:delete','recorder:restore','recorder:start','recorder:stop'])assert(result.calls.some(call=>call.name===method),method);
      assert.equal(result.calls.find(call=>call.name==='recorder:read').payload.eventId,'event');assert.equal(result.recording,false);
      console.log('RECORDER_PANEL_PASS');window.destroy();app.exit(0);
    }catch(error){console.error(error.stack);window.destroy();app.exit(1);}});
  `;
  try {
    await writeFile(script, code);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
    clearTimeout(timer); assert.equal(exit, 0, output); assert.match(output, /RECORDER_PANEL_PASS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
