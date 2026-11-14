'use strict';

(()=>{
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
 let root,invoke,state,pending=false,error='';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function button(label,fn){const n=el('button',label);n.type='button';n.disabled=pending;n.onclick=fn;return n;}
 async function run(action,payload={}){pending=true;error='';render();try{state=await invoke(action,payload);}catch(e){error=String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}finally{pending=false;render();}}
 function render(){
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;if(!root||!state)return;root.replaceChildren();root.className='vsj-root';
  root.append(el('p',tr("When explicitly enabled, macOS checks opted-in plain CLI automations every minute while you are logged in. Missed checks coalesce after the computer wakes. This does not wake a sleeping computer or run native providers without an approval UI.")));
  if(error||state.error){const n=el('p',(globalThis.WiekI18n?.error(error||state.error) ?? (error||state.error)));n.className='vsj-error';n.role='alert';root.append(n);}
  const card=el('section');card.append(el('h2',tr("Login job")),el('p',state.enabled?tr("Execution consent: enabled"):tr("Execution consent: off")),el('p',tr('Setup file: {0} · OS job: {1}', tr(state.installed===null?'could not be validated':state.installed?'installed':'absent'), tr(state.loaded===null?'not checked':state.loaded?'loaded':'not loaded'))),el('p',tr("Only automations with Allow a closed-app worker tick enabled are eligible. Foreground Wiek takes priority and requests a running worker to settle before opening its data.")));
  if(state.availabilityReason)card.append(el('p',state.availabilityReason));
  if(state.runtime)card.append(el('p',tr('Reviewed version: {0}', state.runtime.version)),el('code',state.runtime.executable));
  if(state.lastTick)card.append(el('p',tr('Last background check: {0} · {1}', tr(state.lastTick.status), new Date(state.lastTick.at).toLocaleString(globalThis.WiekI18n?.locale()))));
  card.append(button(tr("Refresh job status"),()=>run('scheduler:job:refresh')),button(tr("Review background scheduling…"),()=>run('scheduler:job:prepare')),button(tr("Disable login job"),()=>run('scheduler:job:disable')),button(tr("Remove setup"),()=>run('scheduler:job:remove')));root.append(card);
  if(state.plan){const review=el('section');review.setAttribute('role','dialog');review.setAttribute('aria-label',tr("Review background scheduling"));review.append(el('h2',tr("Review background scheduling")),el('p',tr("Enable a login job for this Wiek data directory. No account credentials are copied into the job. Changes to the reviewed Wiek executable or JavaScript block execution until you review a new setup.")),el('p','Runtime · Wiek '+state.plan.version+' · Node '+state.plan.nodeVersion),el('code',state.plan.executable),el('p',tr("Login job file")),el('code',state.plan.plist),el('p',tr("Private launcher")),el('code',state.plan.bootstrap),el('p',tr('{0} · worker timeout {1} seconds', state.plan.calendar, state.plan.timeoutMs/1000)),el('p',tr("Disable unloads the job and removes its login file. Remove setup also clears its private launcher and receipt. Automation history stays in Wiek.")),button(tr("Cancel review"),()=>run('scheduler:job:cancel')),button(tr("Enable reviewed login job"),()=>run('scheduler:job:enable',{token:state.plan.token})));root.append(review);}
 }
 window.WiekSchedulerPanel={mount(target,dispatch){root=target;invoke=dispatch;state=null;error='';pending=false;void run('scheduler:snapshot');},dispose(){root=null;state=null;},update(){}};
})();
