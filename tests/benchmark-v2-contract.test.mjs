import test from 'node:test';
import assert from 'node:assert/strict';
import {createBenchmarkV2} from '../tools/benchmark-sdk-v2-contract.mjs';

function fixture({spaces=[{id:7,name:'task',ownership:'agent'}],tabs,finish,resolve}={}){
  const calls=[];
  const page={cdp:async(method)=>{calls.push(method);return method==='Page.captureScreenshot'?{data:'fixture-png'}:{nodes:[{name:{value:'fixture'}}]};}};
  const task={tabs:async()=>tabs||[{active:true,targetId:'a',page}],finish:async options=>{calls.push(options);return finish||{closedSpace:true};}};
  const control=createBenchmarkV2({listTaskSpaces:async()=>spaces,taskSpace:async id=>{calls.push({selected:id});return resolve?resolve(id):task;}});
  return {control,calls,page};
}

test('missing cleanup and capture never create a named task',async()=>{
  const {control,calls}=fixture({spaces:[]});
  assert.deepEqual(await control.close(['absent']),[{candidate:'absent',ok:true,notFound:true}]);
  await assert.rejects(control.capture(['absent']),/not found/);assert.deepEqual(calls,[]);
});
test('user ownership is a boundary even when another candidate is Agent-owned',async()=>{
  const {control,calls}=fixture({spaces:[{id:7,name:'user',ownership:'user'},{id:8,name:'agent',ownership:'agent'}]});
  await assert.rejects(control.capture(['user','agent']),/not Agent-owned/);
  assert.equal((await control.close(['user']))[0].ok,false);assert.deepEqual(calls,[]);
});
test('numeric-looking names resolve by name before id, then use a numeric handle',async()=>{
  const {control,calls}=fixture({spaces:[{id:7,name:'other',ownership:'agent'},{id:8,name:'7',ownership:'agent'}]});
  assert.equal((await control.existing(['7'])).descriptor.id,8);assert.deepEqual(calls,[{selected:8}]);
});
test('ownership race fails without retrying a different task',async()=>{
  const {control,calls}=fixture({resolve:()=>{throw new Error('control changed');}});
  await assert.rejects(control.capture(['task','another']),/control changed/);assert.deepEqual(calls,[{selected:7}]);
});
test('screenshot and AX use the selected page without reading another tab',async()=>{
  const methods=[];const selected={cdp:async method=>{methods.push(method);return method==='Page.captureScreenshot'?{data:'png'}:{nodes:[]};}};
  const other={cdp:()=>{throw new Error('cross-page read');}};
  const {control}=fixture({tabs:[{active:false,page:other},{active:true,page:selected,targetId:'selected'}]});
  assert.equal((await control.capture(['task'])).targetId,'selected');assert.deepEqual(methods,['Page.captureScreenshot','Accessibility.getFullAXTree']);
});
test('active unmanaged page cannot fall back to an inactive managed page',async()=>{
  const {control}=fixture({tabs:[{active:true,page:{}},{active:false,page:{cdp:()=>assert.fail('must not capture')}}]});
  await assert.rejects(control.capture(['task']),/unmanaged/);
});
test('missing or ambiguous active pages produce an explicit error',async()=>{
  for(const tabs of [[],[{active:true},{active:true}]])await assert.rejects(fixture({tabs}).control.capture(['task']),/exactly one active/);
});
test('empty screenshot fails before AX, and screenshot errors do not select another candidate',async()=>{
  const methods=[];const {control}=fixture({tabs:[{active:true,page:{cdp:async method=>{methods.push(method);return {data:''};}}}]});
  await assert.rejects(control.capture(['task']),/Empty screenshot/);assert.deepEqual(methods,['Page.captureScreenshot']);
});
test('optional AX error is preserved alongside a successful screenshot',async()=>{
  const {control}=fixture({tabs:[{active:true,page:{cdp:async method=>{if(method.startsWith('Accessibility'))throw new Error('AX unavailable');return {data:'png'};}}}]});
  const capture=await control.capture(['task']);assert.equal(capture.data,'png');assert.equal(capture.ax,null);assert.equal(capture.axError,'AX unavailable');
});
test('protected-page receipt stays incomplete without force-closing or claiming',async()=>{
  const receipt={closedSpace:false,preservedUnmanagedCount:1,keptManagedLabels:['p2']};const {control,calls}=fixture({finish:receipt});
  const rows=await control.close(['task']);assert.equal(rows[0].ok,false);assert.deepEqual(rows[0].receipt,receipt);assert.deepEqual(calls,[{selected:7},{keep:[]}]);
});
test('cleanup reports per-candidate failures and continues only explicit candidates',async()=>{
  const {control}=fixture({resolve:()=>{throw new Error('native permission changed');}});
  const rows=await control.close(['task','absent']);assert.equal(rows[0].ok,false);assert.match(rows[0].error,/permission changed/);assert.equal(rows[1].notFound,true);
});
