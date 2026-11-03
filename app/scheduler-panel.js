'use strict';
(()=>{
 let root,invoke,state,pending=false,error='';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function button(label,fn){const n=el('button',label);n.type='button';n.disabled=pending;n.onclick=fn;return n;}
 async function run(action,payload={}){pending=true;error='';render();try{state=await invoke(action,payload);}catch(e){error=String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}finally{pending=false;render();}}
 function render(){if(!root||!state)return;root.replaceChildren();root.className='vsj-root';
  root.append(el('p','When explicitly enabled, macOS checks opted-in plain CLI automations every minute while you are logged in. Missed checks coalesce after the computer wakes. This does not wake a sleeping computer or run native providers without an approval UI.'));
  if(error||state.error){const n=el('p',error||state.error);n.className='vsj-error';n.role='alert';root.append(n);}
  const card=el('section');card.append(el('h2','Login job'),el('p',state.enabled?'Execution consent: enabled':'Execution consent: off'),el('p','Setup file: '+(state.installed===null?'could not be validated':state.installed?'installed':'absent')+' · OS job: '+(state.loaded===null?'not checked':state.loaded?'loaded':'not loaded')),el('p','Only automations with Allow a closed-app worker tick enabled are eligible. Foreground Wiek takes priority and requests a running worker to settle before opening its data.'));
  if(state.availabilityReason)card.append(el('p',state.availabilityReason));
  if(state.runtime)card.append(el('p','Reviewed version: '+state.runtime.version),el('code',state.runtime.executable));
  if(state.lastTick)card.append(el('p','Last background check: '+state.lastTick.status+' · '+state.lastTick.at));
  card.append(button('Refresh job status',()=>run('scheduler:job:refresh')),button('Review background scheduling…',()=>run('scheduler:job:prepare')),button('Disable login job',()=>run('scheduler:job:disable')),button('Remove setup',()=>run('scheduler:job:remove')));root.append(card);
  if(state.plan){const review=el('section');review.setAttribute('role','dialog');review.setAttribute('aria-label','Review background scheduling');review.append(el('h2','Review background scheduling'),el('p','Enable a login job for this Wiek data directory. No account credentials are copied into the job. Changes to the reviewed Wiek executable or JavaScript block execution until you review a new setup.'),el('p','Runtime · Wiek '+state.plan.version+' · Node '+state.plan.nodeVersion),el('code',state.plan.executable),el('p','Login job file'),el('code',state.plan.plist),el('p','Private launcher'),el('code',state.plan.bootstrap),el('p',state.plan.calendar+' · worker timeout '+state.plan.timeoutMs/1000+' seconds'),el('p','Disable unloads the job and removes its login file. Remove setup also clears its private launcher and receipt. Automation history stays in Wiek.'),button('Cancel review',()=>run('scheduler:job:cancel')),button('Enable reviewed login job',()=>run('scheduler:job:enable',{token:state.plan.token})));root.append(review);}
 }
 window.WiekSchedulerPanel={mount(target,dispatch){root=target;invoke=dispatch;state=null;error='';pending=false;void run('scheduler:snapshot');},dispose(){root=null;state=null;},update(){}};
})();
