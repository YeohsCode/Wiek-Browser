// Disposable native-UI fixture preparation; performs no UI automation/model call.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createRequire} from 'node:module';
const {createAgentService}=createRequire(import.meta.url)('../../app/agent-service.cjs');
const dataRoot=resolve(import.meta.dirname,'../../data'),dir=resolve(process.argv[2]||'');
if(!dir.startsWith(dataRoot+sep)||!dir.includes('v150-native'))throw Error('Choose an explicit v150-native fixture directory under repository data/');
await mkdir(dir,{recursive:true,mode:0o700});
const service=createAgentService({dataDir:dir,autoSchedule:false,discoverProviders:false});
try{
 if(process.argv[3]==='--arm'){
  const automation=service.snapshot().automations.find(a=>a.name==='Native UI fixture');if(!automation||automation.executionMode!=='dedicated'||!automation.closedAppAllowed)throw Error('First select dedicated and opt in through the actual UI');
  await service.dispatch('agents:automations:resume',{id:automation.id});console.log(JSON.stringify({armed:true,automationId:automation.id,ownedThreadId:automation.ownedThreadId}));
 }else{
  if(service.snapshot().threads.length)throw Error('Fixture directory is not fresh');
  const provider=join(dir,'public-fixture.cjs');await writeFile(provider,"let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>console.log('OFFLINE_FIXTURE_OUTPUT:'+text));");
  await service.dispatch('agents:providers:configure',{id:'offline-fixture',name:'Offline fixture · no model',command:process.execPath,args:[provider],inputMode:'stdin'});
  await service.dispatch('agents:projects:create',{name:'Disposable scheduler fixture',path:dir});await service.dispatch('agents:threads:create',{projectId:service.snapshot().projects[0].id,providerId:'offline-fixture',title:'Public source template'});const sourceId=service.snapshot().threads[0].id;
  await service.dispatch('agents:threads:prompt',{id:sourceId,prompt:'PUBLIC_SOURCE_CONTEXT'});while(service.snapshot().runningCount)await new Promise(r=>setTimeout(r,10));
  await service.dispatch('agents:automations:create',{threadId:sourceId,name:'Native UI fixture',prompt:'PUBLIC_AUTOMATION_REQUEST',kind:'at',at:new Date(Date.now()-60000).toISOString(),status:'paused'});
  console.log(JSON.stringify({prepared:true,sourceId,modelCalls:0}));
 }
}finally{await service.close();}
