#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'vek-cdp-probe-'));
const script = join(directory, 'probe.cjs');
await writeFile(script, `
const {app,BrowserWindow}=require('electron');
const {isDeepStrictEqual}=require('node:util');
const {decodeDeep,sendOrdered}=require(${JSON.stringify(join(root,'app/cdp-transport.cjs'))});
app.setPath('userData',${JSON.stringify(join(directory,'profile'))});
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await w.loadURL('data:text/html,<title>CDP probe</title>');const d=w.webContents.debugger;d.attach('1.3');
 const cases={date:'new Date("2024-01-01T00:00:00Z")',map:'new Map([["a",1]])',set:'new Set([1,2])',uint8:'new Uint8Array([3,8,13])',float32:'new Float32Array([1.5,2.5])',undefined:'undefined',nan:'NaN',infinity:'Infinity',negativeInfinity:'-Infinity',negativeZero:'-0',bigint:'123n',cyclic:'(()=>{const x={};x.self=x;return x})()',nestedTyped:'({z:new Uint8Array([7,9]),a:{target:0,overlay:0}})',nestedUndefined:'({a:undefined,b:[undefined,NaN,Infinity]})',nestedBigInt:'({a:123n})',regexp:'/foo/gi',error:'new Error("oops")',arraybuffer:'new ArrayBuffer(4)',ownDate:'Object.assign(new Date(),{hello:42})',keys:'({target:0,overlay:0})'};
 let mismatches=0;
 for(const [name,expression]of Object.entries(cases)){
  let native,deep,ordered; try{native=await d.sendCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})}catch(e){native={error:e.message}}
  try{deep=await d.sendCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,serializationOptions:{serialization:'deep'}})}catch(e){deep={error:e.message}}
  try{ordered=await sendOrdered(d,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});JSON.stringify(ordered)}catch(e){ordered={error:e.message}}
  const wire=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const mismatch=!isDeepStrictEqual(wire(native.result?.value),wire(ordered.result?.value))||native.error!==ordered.error||native.result?.unserializableValue!==ordered.result?.unserializableValue;
  const insertionOrder=name==='keys'?Object.keys(ordered.result.value).join(',')==='target,overlay':name==='nestedTyped'?Object.keys(ordered.result.value).join(',')==='z,a'&&Object.keys(ordered.result.value.a).join(',')==='target,overlay':true;
  if(!insertionOrder)mismatches++;
  if(mismatch)mismatches++;
  console.log(JSON.stringify({name,native,deep,ordered,mismatch,insertionOrder}));
 }
 await d.sendCommand('Runtime.evaluate',{expression:'window.__vekProbeCount=0'});
 const once=await sendOrdered(d,'Runtime.evaluate',{expression:'(()=>{window.__vekProbeCount++;return {z:new Uint8Array([4]),a:window.__vekProbeCount}})()',returnByValue:true});
 const count=await d.sendCommand('Runtime.evaluate',{expression:'window.__vekProbeCount',returnByValue:true});
 const singleExecution=count.result.value===1&&once.result.value.a===1&&once.result.value.z['0']===4;
 if(!singleExecution)mismatches++;console.log(JSON.stringify({name:'single-expression-execution',singleExecution}));
 const handle=await d.sendCommand('Runtime.evaluate',{expression:'({})'});
 const called=await sendOrdered(d,'Runtime.callFunctionOn',{objectId:handle.result.objectId,functionDeclaration:'function(){window.__vekProbeCount++;return {target:7,overlay:new Uint8Array([9])}}',returnByValue:true});
 const count2=await d.sendCommand('Runtime.evaluate',{expression:'window.__vekProbeCount',returnByValue:true});
 const singleFunctionExecution=count2.result.value===2&&called.result.value.target===7&&called.result.value.overlay['0']===9&&Object.keys(called.result.value).join(',')==='target,overlay';
 if(!singleFunctionExecution)mismatches++;console.log(JSON.stringify({name:'single-function-execution',singleFunctionExecution}));
 console.log('PROBE_SUMMARY '+JSON.stringify({cases:Object.keys(cases).length+2,mismatches}));app.exit(mismatches?1:0);
}).catch(e=>{console.error(e);app.exit(1)});
`);
const child = spawn(electron,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:['ignore','pipe','pipe']});
let output=''; child.stdout.on('data',data=>{output+=data;process.stdout.write(data)}); child.stderr.on('data',data=>process.stderr.write(data));
const code=await new Promise(resolve=>child.once('close',resolve));
await writeFile(join(root,'reports/cdp-transport-probe.log'),output);
await rm(directory,{recursive:true,force:true});
process.exitCode=code;
