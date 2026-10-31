'use strict';
(() => {
  let root, invoke, appState, mode, catalog, voice, error = '', detail = null, busy = false, recording = null, transcript = '';
  let projectId = '', threadId = '';
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (label, run) => { const b = node('button', label); b.type = 'button'; b.disabled = busy; b.onclick = () => execute(run); return b; };
  async function execute(run) { error = ''; busy = true; render(); try { await run(); } catch (failure) { error = failure.message; } finally { busy = false; render(); } }
  async function refresh() { if (mode === 'catalog') catalog = await invoke('catalog:list', { projectId: projectId || undefined }); else voice = await invoke('voice:snapshot'); }
  function selector(label, values, selected, changed) { const wrap = node('label', label), select = node('select'); for (const [id, name] of values) { const option = node('option', name); option.value = id; select.append(option); } select.value = selected; select.onchange = () => execute(() => changed(select.value)); wrap.append(select); return wrap; }
  function card(title, description) { const c = node('section', '', 'card'); c.append(node('h3', title), node('p', description)); root.append(c); return c; }
  function render() {
    if (!root || !root.isConnected) return;
    root.replaceChildren();
    if (error) root.append(node('p', error, 'tools-error'));
    if (mode === 'catalog') renderCatalog(); else renderVoice();
  }
  function renderCatalog() {
    const projects = appState.agents?.projects || [], threads = appState.agents?.threads || [];
    const controls = card('Skills, commands & agents', 'Discover local instruction files. Read a file before selecting it for a conversation; selected files are included in the next provider turn. Disable affects Vek’s catalog only.');
    controls.append(selector('Project', [['','User catalog'], ...projects.map(p => [p.id,p.name])], projectId, async id => { projectId = id; detail = null; await refresh(); }));
    controls.append(selector('Conversation', [['','Choose a conversation'], ...threads.filter(t => !projectId || t.projectId === projectId).map(t => [t.id,t.title])], threadId, async id => { threadId = id; const thread = threads.find(t => t.id === id); if (thread) projectId = thread.projectId; await refresh(); }));
    controls.append(button('Refresh', refresh));
    if (!catalog) { controls.append(node('p', 'Loading catalog…')); return; }
    const list = card(`${catalog.entries.length} entries`, 'Project entries and user entries are listed with their source. No plugin installation or global configuration changes are performed.');
    for (const entry of catalog.entries) {
      const row = node('div', '', 'row'), main = node('div', '', 'row-main'); main.append(node('strong', entry.name), node('p', `${entry.kind} · ${entry.scope} · ${entry.description}`, 'row-sub')); row.append(main);
      row.append(button('Read', async () => { detail = await invoke('catalog:read', { id: entry.id }); }));
      row.append(button(entry.disabled ? 'Enable' : 'Disable', async () => { catalog = await invoke('catalog:toggle', { id: entry.id, projectId: projectId || undefined }); }));
      const selected = catalog.selections[threadId] || [];
      if (threadId && !entry.disabled) row.append(button(selected.includes(entry.id) ? 'Remove from conversation' : 'Use in conversation', async () => { const ids = selected.includes(entry.id) ? selected.filter(id => id !== entry.id) : [...selected, entry.id]; catalog = await invoke('catalog:select', { threadId, ids, projectId }); }));
      list.append(row);
    }
    if (detail) { const preview = card(detail.name, detail.path); const pre = node('pre', detail.content, 'tools-source'); preview.append(pre); }
  }
  function renderVoice() {
    const intro = card('Local voice transcription', 'Record a message or choose an audio file. Transcription runs locally using a configured executable; the resulting text can be added to a conversation draft. It is never sent automatically.');
    if (!voice) { intro.append(node('p', 'Loading voice settings…')); return; }
    const bundled=voice.config?.command?.endsWith('/app/bin/whisper-cli');
    intro.append(node('p', voice.configured ? bundled?'Whisper · multilingual · runs on this device':`Local provider: ${voice.config.command.split(/[\\/]/).pop()}` : 'No local transcription provider is configured.'));
    const upload = document.createElement('input'); upload.type = 'file'; upload.accept = '.wav,.mp3,.ogg,.webm,.m4a'; upload.setAttribute('aria-label','Audio file'); upload.disabled = busy;
    upload.onchange = () => { const file = upload.files[0]; if (!file) return; execute(async () => { const mime = file.type || ({wav:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg',webm:'audio/webm',m4a:'audio/mp4'})[file.name.split('.').pop()]; if (file.size > voice.maxAudioBytes) throw new Error('Audio exceeds the 20 MiB limit'); await transcribe(new Uint8Array(await file.arrayBuffer()), mime); }); };
    intro.append(upload);
    intro.append(button(recording ? 'Stop recording & transcribe' : 'Record microphone', async () => { if (recording) { await stopRecording(); return; } await startRecording(); }));
    if (busy) { const stop = button('Stop transcription', async () => { await invoke('voice:stop'); }); stop.disabled=false; intro.append(stop); }
    if (recording) intro.append(node('p', 'Recording on this device… stop within 2 minutes.'));
    if (transcript) { const c = card('Transcript', 'Review this text before sending.'); const text = node('textarea'); text.value = transcript; text.rows = 6; text.setAttribute('aria-label','Voice transcript'); text.oninput = () => transcript = text.value; c.append(text); c.append(button('Add to selected conversation draft', () => { if (!window.VekAgentPanel.appendDraft(transcript)) throw new Error('Open a conversation in Agents first, then return here.'); window.dispatchEvent(new CustomEvent('vek:show-panel', { detail: 'agents' })); })); }
    const settings = card('Transcription provider', 'Arguments run without a shell. Use {audio} for the temporary recording path; file-output tools can use {output}. Whisper example: ["-m","/path/ggml-tiny.bin","-f","{audio}","-l","auto","-nt","-np"].');
    const form = node('form'), command = node('input'), args = node('textarea'); command.placeholder = '/absolute/path/to/transcriber'; command.value = voice.config?.command || ''; command.setAttribute('aria-label','Transcriber executable'); args.rows = 4; args.value = JSON.stringify(voice.config?.args || []); args.setAttribute('aria-label','Transcriber arguments JSON');
    const output = document.createElement('select'); for (const [id, name] of [['stdout','Text on standard output'],['file','Text at {output} path']]) { const option = node('option',name); option.value=id; output.append(option); } output.value = voice.config?.output || 'stdout';
    const save = node('button','Save provider'); save.disabled = busy; form.append(command,args,output,save); form.onsubmit = e => { e.preventDefault(); const values = {command:command.value,args:args.value,output:output.value};execute(async () => voice = await invoke('voice:configure',{...values,args:JSON.parse(values.args)})); }; settings.append(form);
    const advanced=node('details'),summary=node('summary','Advanced: choose another transcription provider');advanced.append(summary,...settings.childNodes);settings.replaceChildren(advanced);
    const prefs=voice.settings || {}, options=card('Voice preferences', 'Transcripts stay on this device for the selected retention period. Audio is kept only when enabled. Dictionary replacements match literal phrases.');
    const prefForm=node('form'), language=node('input'); language.value=prefs.language || 'auto'; language.setAttribute('aria-label','Speech language');
    const retention=node('input');retention.type='number';retention.min='0';retention.max='365';retention.value=prefs.historyRetentionDays ?? 7;retention.setAttribute('aria-label','Transcript retention days');
    prefForm.append(node('label','Language code (auto, en, zh…)'),language,node('label','Transcript retention days (0 disables history)'),retention);
    const checks={};for (const [key,label] of [['keepAudio','Keep audio for download'],['sounds','Play start/stop sounds'],['muteOtherAudio','Mute browser pages while recording']]) {const wrap=node('label',label),check=document.createElement('input');check.type='checkbox';check.checked=Boolean(prefs[key]);checks[key]=check;wrap.prepend(check);prefForm.append(wrap);}
    const dictionary=node('textarea');dictionary.rows=5;dictionary.value=JSON.stringify(prefs.dictionary || [],null,2);dictionary.setAttribute('aria-label','Voice dictionary JSON');prefForm.append(node('label','Dictionary: [{"from":"phrase","to":"replacement"}]'),dictionary,node('button','Save voice preferences'));
    prefForm.onsubmit=e=>{e.preventDefault();execute(async()=>{const values={language:language.value,historyRetentionDays:Number(retention.value),dictionary:JSON.parse(dictionary.value),...Object.fromEntries(Object.entries(checks).map(([key,input])=>[key,input.checked]))};voice=await invoke('voice:settings:update',values);});}; options.append(prefForm);
    const history=card('Transcript history','Deleted items can be restored until their retention period expires.');
    for(const entry of voice.history || []) { const row=node('div','','voice-history-item');row.append(node('strong',new Date(entry.createdAt).toLocaleString()),node('p',entry.text));
      row.append(button(entry.trashed?'Restore':'Delete',async()=>voice=await invoke(entry.trashed?'voice:history:restore':'voice:history:delete',{id:entry.id})));
      if(!entry.trashed)row.append(button('Use transcript',async()=>transcript=entry.text));
      if(entry.hasAudio&&!entry.trashed)row.append(button('Save audio…',async()=>{await invoke('voice:history:save-audio',{id:entry.id});}));history.append(row);
    }
  }
  async function transcribe(audio, mime) { const result = await invoke('voice:transcribe', { audio, mime: mime?.split(';')[0] }); transcript = result.text; voice=await invoke('voice:snapshot'); }
  function cue(context,frequency) { if(!voice.settings?.sounds)return;const oscillator=context.createOscillator(),gain=context.createGain();gain.gain.value=0.04;oscillator.frequency.value=frequency;oscillator.connect(gain);gain.connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+0.1); }
  async function startRecording() {
    if (!voice.configured) throw new Error('Configure a local transcription provider first');
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    // PCM WAV keeps recorded audio compatible with local whisper-cli.
    const context = new AudioContext({sampleRate:16000}), source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096,1,1), mute = context.createGain(); mute.gain.value = 0;
    const chunks = []; let samples = 0;
    processor.onaudioprocess = event => { const data = new Float32Array(event.inputBuffer.getChannelData(0)); if (samples + data.length <= context.sampleRate * 120) { chunks.push(data); samples += data.length; } };
    source.connect(processor); processor.connect(mute); mute.connect(context.destination); await context.resume();cue(context,640);
    try { await invoke('voice:recording',{active:true,mute:voice.settings?.muteOtherAudio===true}); } catch(error) {stream.getTracks().forEach(t=>t.stop());await context.close();throw error;}
    recording = { stream,context,source,processor,mute,chunks, get samples() { return samples; } };
    recording.timer = setTimeout(() => execute(stopRecording),120000);
  }
  async function stopRecording() {
    const r = recording; if (!r) return; recording = null; clearTimeout(r.timer); r.processor.disconnect(); r.source.disconnect(); r.mute.disconnect(); r.stream.getTracks().forEach(t => t.stop());cue(r.context,480); await new Promise(resolve=>setTimeout(resolve,110)); await r.context.close();await invoke('voice:recording',{active:false});
    const buffer = new ArrayBuffer(44 + r.samples * 2), view = new DataView(buffer); const text = (offset, value) => [...value].forEach((char,index) => view.setUint8(offset+index,char.charCodeAt(0)));
    text(0,'RIFF'); view.setUint32(4,buffer.byteLength-8,true); text(8,'WAVE'); text(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,r.context.sampleRate,true); view.setUint32(28,r.context.sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,r.samples*2,true);
    let offset = 44; for (const chunk of r.chunks) for (const sample of chunk) { view.setInt16(offset,Math.round(Math.max(-1,Math.min(1,sample))*32767),true); offset+=2; }
    await transcribe(new Uint8Array(buffer),'audio/wav');
  }
  window.VekToolsPanel = {
    mount(target, dispatch, state, selectedMode) { root=target; invoke=dispatch; appState=state; mode=selectedMode; error=''; detail=null; catalog=null; voice=null; render(); void execute(refresh); },
    update(state) { appState=state; },
    dispose() { if (recording) { clearTimeout(recording.timer); recording.processor.disconnect();recording.source.disconnect();recording.mute.disconnect();recording.stream.getTracks().forEach(t=>t.stop());void recording.context.close();void invoke('voice:recording',{active:false});recording=null; } },
  };
})();
