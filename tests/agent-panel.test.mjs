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
          VekAgentPanel.mount(document.querySelector('#panel'), async (name, payload) => { calls.push({ name, payload }); if (name === 'agents:threads:pin') seed.threads[0].pinned = true; if (name === 'agents:attachments:remove') seed.threads[0].attachments[0].detachedAt = new Date().toISOString(); if (name === 'agents:attachments:restore') delete seed.threads[0].attachments[0].detachedAt; if (name === 'agents:file:claude:preview') return { ...structuredClone(seed), claudeImportPreview: { token:'preview-token', sourceName:'fixture.jsonl', branches:[{id:'first',label:'First branch'},{id:'second',label:'Second branch'}], excludedEntries:1, missingParents:0, previewText:'First selected branch' } };
            if (name === 'agents:claude:branch') return { ...structuredClone(seed), claudeBranchPreview:{leafId:payload.leafId,text:'Second selected branch preview'} };
            if (name === 'agents:claude:import') { seed.threads.push({id:'imported',projectId:'project',providerId:'p',title:'Imported Claude',status:'idle',messages:[],runs:[],claudeHistory:{sourceName:'fixture.jsonl',activity:{toolEvents:[{id:'tool',name:'Read',status:'completed',input:'Input literal',result:'<img src=x onerror=window.toolXss=true>'}],subagents:[{id:'child',status:'completed',messages:[{role:'assistant',content:'Nested child result'}]}]}}});return {...structuredClone(seed),importedThreadId:'imported'}; }
            if(name==='agents:file:codex:preview')return {...structuredClone(seed),codexImportPreview:{token:'codex-preview',replay:{compactions:2,rollbackEvents:1},sourceName:'rollout.jsonl',messageCount:2,contextEntries:1,attachmentsOmitted:0,previewText:'Selected Codex transcript'}};
            if(name==='agents:codex:import'){seed.threads.push({id:'codex-import',projectId:'project',providerId:'p',title:'Imported Codex',status:'idle',messages:[],runs:[],codexHistory:{sourceName:'rollout.jsonl',activity:{toolEvents:[{id:'c-tool',name:'Read',status:'completed',result:'Codex historical tool output'}]}}});return {...structuredClone(seed),importedThreadId:'codex-import'};}
            return structuredClone(seed); });
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
          await click('Conversations'); await click('Import Claude history');
          const branch = document.querySelector('[data-focus="editor-leafId"]'); branch.value='second'; branch.onchange(); await new Promise(resolve=>setTimeout(resolve,30));
          const changedBranchPreview=document.body.textContent.includes('Second selected branch preview');
          await document.querySelector('.va-dialog').onsubmit({preventDefault(){}});
          const importedActivity=document.body.textContent.includes('Nested child result')&&document.body.textContent.includes('<img src=x onerror=window.toolXss=true>')&&!window.toolXss&&!document.querySelector('img');
          seed.providers[0].protocol='opencode-acp'; VekAgentPanel.update(seed); await click('Model');
          const discoveryOnly=calls.at(-1).name==='agents:threads:discover-models';
          seed.threads.at(-1).nativeCatalog={observedAt:new Date().toISOString(),models:[{id:'fixture/b',name:'Observed model B'}]}; VekAgentPanel.update(seed);await click('Model');
          const model=document.querySelector('[data-focus="editor-model"]'); const observedModels=[...model.options].map(x=>x.textContent);model.value='fixture/b';model.oninput();await document.querySelector('.va-dialog').onsubmit({preventDefault(){}});
          seed.threads.at(-1).runs=[{status:'running',approvals:[{id:'permission',status:'pending',title:'No once option',canAccept:false}]}];VekAgentPanel.update(seed);const cannotAccept=button('Approve this request').disabled;
          seed.threads.at(-1).status='discovering';VekAgentPanel.update(seed);const discoveryBusy=button('Discovering models…').disabled&&document.querySelector('.va-composer textarea').disabled&&document.body.textContent.includes('No prompt is sent.');
          seed.threads.at(-1).status='completed';seed.providers[0].protocol='codex-app-server';seed.threads.at(-1).nativeCatalog={observedAt:new Date().toISOString(),models:[{id:'fixture/a',name:'Codex observed A',reasoningEfforts:['low','high'],inputModalities:['text','image']}]};VekAgentPanel.update(seed);await click('Model');
          const codexModel=document.querySelector('[data-focus="editor-model"]');codexModel.value='fixture/a';codexModel.onchange();const effort=document.querySelector('[data-focus="editor-reasoningEffort"]');const availableEfforts=[...effort.options].map(x=>x.value);effort.value='high';effort.oninput();await document.querySelector('.va-dialog').onsubmit({preventDefault(){}});
          await click('Import Codex history');const codexPreviewVisible=document.body.textContent.includes('Selected Codex transcript')&&document.body.textContent.includes('2 compactions and 1 rollback markers');await document.querySelector('.va-dialog').onsubmit({preventDefault(){}});const codexActivityVisible=document.body.textContent.includes('Imported Codex history');
          seed.providers[0].protocol='claude-stream-json';seed.threads.at(-1).model='fixture/canonical';seed.threads.at(-1).reasoningEffort='high';seed.threads.at(-1).nativeCatalog={source:'claude-initialize',models:[{id:'default',name:'Claude observed default',resolvedModel:'fixture/canonical',supportsEffort:true,reasoningEfforts:['low','high']},{id:'older',name:'Older native',reasoningEfforts:[]}]};VekAgentPanel.update(seed);await click('Model');
          const claudeCanonicalPreserved=document.querySelector('[data-focus="editor-model"]').value==='fixture/canonical'&&document.querySelector('[data-focus="editor-reasoningEffort"]').value==='high';
          const claudeSelect=document.querySelector('[data-focus="editor-model"]');claudeSelect.value='older';claudeSelect.onchange();const claudeUnknownEffort=document.body.textContent.includes('effort unknown')&&document.querySelector('[data-focus="editor-reasoningEffort"]').options.length===1;await document.querySelector('.va-dialog').onsubmit({preventDefault(){}});
          return { claudeCanonicalPreserved,claudeUnknownEffort,literal, draft, draftValue, noAutoSend, memoryVisible, changedBranchPreview, importedActivity, discoveryOnly,observedModels,cannotAccept,discoveryBusy,availableEfforts,codexPreviewVisible,codexActivityVisible,calls };
        }.toString())}+')()');
        assert.equal(result.claudeCanonicalPreserved,true);assert.equal(result.claudeUnknownEffort,true);assert.equal(result.literal,true);assert.equal(result.draft,true);assert.equal(result.draftValue,'Voice transcription draft');assert.equal(result.noAutoSend,true);assert.equal(result.memoryVisible,true);assert.equal(result.changedBranchPreview,true);assert.equal(result.importedActivity,true);assert.equal(result.discoveryOnly,true);assert.deepEqual(result.observedModels,['Keep current agent model','Observed model B']);assert.equal(result.cannotAccept,true);assert.equal(result.discoveryBusy,true);assert.deepEqual(result.availableEfforts,['','low','high']);assert.equal(result.codexPreviewVisible,true);assert.equal(result.codexActivityVisible,true);assert(result.calls.some(x=>x.name==='agents:threads:model'&&x.payload.reasoningEffort==='high'));assert(result.calls.some(x=>x.name==='agents:threads:model'&&x.payload.model==='fixture/b'));
        for(const action of ['agents:file:claude:preview','agents:claude:branch','agents:claude:import','agents:threads:pin','agents:file:export','agents:file:import','agents:files:attach','agents:files:open','agents:attachments:remove','agents:attachments:restore','agents:threads:resend','agents:proposals:accept','agents:automations:create'])assert(result.calls.some(call=>call.name===action),action);
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
