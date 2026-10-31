import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('real Electron panel renders literal messages and dispatches advanced controls without model calls', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vek-agent-ui-test-'));
  const script = join(directory, 'test.cjs');
  const panelPath = resolve(new URL('../app/agent-panel.js', import.meta.url).pathname);
  const source = `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
      try{
        await window.loadURL('data:text/html,<main id="panel"></main>');
        await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(panelPath)},'utf8'));
        const result=await window.webContents.executeJavaScript('('+${JSON.stringify(async function probe() {
          const seed = { providers: [{ id: 'p', name: 'Fake CLI', command: 'test-only', args: [], enabled: true, available: true, models: ['test-model'], modelArgs: ['--model', '{model}'] }], projects: [{ id: 'project', name: 'Test project', path: '/test/project' }], threads: [{ id: 't', projectId: 'project', providerId: 'p', title: 'Test conversation', status: 'completed', messages: [{ id: 'm', role: 'user', content: '<img src=x onerror="window.xss=true">', createdAt: new Date().toISOString() }], runs: [{ status: 'completed', stdout: 'Actual output', stderr: 'Actual stderr', exitCode: 0 }], markers: [], revisions: [], notes: '', archived: false }], automations: [{ id: 'a', name: 'Heartbeat', threadId: 't', prompt: 'Local check', kind: 'heartbeat', intervalMs: 60000, memory: 'Remember progress', status: 'paused' }], proposals: [{ id: 'proposal', title: 'Manual proposal', threadId: 't', prompt: 'Only on approval', status: 'pending', source: 'manual' }], runningCount: 0, maxConcurrentRuns: 2 };
          seed.threads[0].attachments = [{ id: 'attached', name: 'local.txt', mimeType: 'text/plain', bytes: 12, available: true }];
          seed.threads[0].messages[0].attachments = structuredClone(seed.threads[0].attachments);
          const calls = [];
          VekAgentPanel.mount(document.querySelector('#panel'), async (name, payload) => { calls.push({ name, payload }); if (name === 'agents:threads:pin') seed.threads[0].pinned = true; if (name === 'agents:attachments:remove') seed.threads[0].attachments[0].detachedAt = new Date().toISOString(); if (name === 'agents:attachments:restore') delete seed.threads[0].attachments[0].detachedAt; return structuredClone(seed); });
          VekAgentPanel.update(seed);
          const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label);
          const click = async label => { const node = button(label); if (!node) throw new Error('Missing button: ' + label); node.click(); await new Promise(resolve => setTimeout(resolve, 15)); };
          const literal = !document.querySelector('img') && !window.xss && document.body.textContent.includes('<img src=x');
          const draft = VekAgentPanel.appendDraft('Voice transcription draft');
          const draftValue = document.querySelector('.va-composer textarea').value;
          const noAutoSend = calls.length === 0;
          await click('Pin');
          await click('Export JSON'); await click('Import JSON');
          await click('Export without files'); await click('Attach files'); await click('📎 local.txt'); await click('Detach'); await click('Restore');
          await click('Edit & resend');
          const edit = document.querySelector('[data-focus="editor-content"]'); edit.value = 'Edited literal text'; edit.oninput();
          await document.querySelector('.va-dialog').onsubmit({ preventDefault() {} });
          await click('Automations');
          const memoryVisible = document.body.textContent.includes('Remember progress');
          await click('Approve & run');
          await click('New automation');
          const kind = document.querySelector('[data-focus="editor-kind"]'); kind.value = 'cron'; kind.onchange();
          const prompt = document.querySelector('[data-focus="editor-prompt"]'); prompt.value = 'Cron local test'; prompt.oninput();
          await document.querySelector('.va-dialog').onsubmit({ preventDefault() {} });
          return { literal, draft, draftValue, noAutoSend, memoryVisible, calls };
        }.toString())}+')()');
        assert.equal(result.literal,true);assert.equal(result.draft,true);assert.equal(result.draftValue,'Voice transcription draft');assert.equal(result.noAutoSend,true);assert.equal(result.memoryVisible,true);
        for(const action of ['agents:threads:pin','agents:file:export','agents:file:import','agents:files:attach','agents:files:open','agents:attachments:remove','agents:attachments:restore','agents:threads:resend','agents:proposals:accept','agents:automations:create'])assert(result.calls.some(call=>call.name===action),action);
        assert(result.calls.some(call=>call.name==='agents:file:export'&&call.payload.metadataOnly===true));
        const cron=result.calls.find(call=>call.name==='agents:automations:create');assert.equal(cron.payload.kind,'cron');assert.equal(cron.payload.timeZone,'UTC');
        console.log('AGENT_PANEL_PASS');window.destroy();app.exit(0);
      }catch(error){console.error(error.stack);window.destroy();app.exit(1);}
    });
  `;
  try {
    await writeFile(script, source);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
    clearTimeout(timer); assert.equal(exit, 0, output); assert.match(output, /AGENT_PANEL_PASS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
