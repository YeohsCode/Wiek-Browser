#!/usr/bin/env node
// Static AST inspection only: extracted client code is never imported/executed.
import fs from 'node:fs';import path from 'node:path';import {createRequire}from'node:module';
const require=createRequire(import.meta.url),acorn=require('../packages/sdk/node_modules/acorn');
const root=path.resolve(import.meta.dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'analysis/extracted-ego-resources/manifest.json')));
const feature=/settings|preferences|import|export|shortcut|clipboard|profile|split|sidebar|vertical|space|pinned|bookmark|download|history|password|passkey|extension|proxy|ad.?block|translate|reading|zoom|screenshot|theme|appearance|search engine|browser|agent|skill|plugin|worktree|terminal|schedule|automation|checkpoint|sidechat|voice|dictation|model|provider|mcp|pair|usage|billing|transcrib|goal|fork|archive|project|notification|permission/i;
const report={kind:'static-inert-client-ast',manifest:'analysis/extracted-ego-resources/manifest.json',resources:[],nativeLocaleStrings:[],limitations:['Original Vite filenames are not guessed from numeric resource IDs.','UI labels/native method names establish shipped UI or bridge surfaces, not successful runtime/provider/account behavior.','The inspected client AST set is separate from the existing daemon Evidence.']};
for(const row of manifest.packs[0].resources){
 if(row.type!=='js'||row.id<58400||row.id>=58900||row.decodedBytes>600000)continue;
 const source=fs.readFileSync(path.join(root,row.path),'utf8');let ast;try{ast=acorn.parse(source,{sourceType:'module',ecmaVersion:'latest',locations:true})}catch{continue}
 const found={id:row.id,path:row.path,sha256:row.decodedSha256,bytes:row.decodedBytes,imports:[],methods:[],uiStrings:[],routes:[],bridgeCalls:[]};
 const seen=new Set();function add(type,value,node){const key=type+':'+value;if(seen.has(key))return;seen.add(key);found[type].push({value,line:node.loc.start.line,start:node.start,end:node.end})}
 function name(node){if(!node)return'';if(node.type==='Identifier')return node.name;if(node.type==='Literal')return String(node.value);if(node.type==='MemberExpression')return name(node.object)+'.'+name(node.property);if(node.type==='ChainExpression')return name(node.expression);return''}
 function visit(node){if(!node||typeof node!=='object')return;
  if(node.type==='ImportDeclaration')add('imports',node.source.value,node);
  if(node.type==='MethodDefinition'&&feature.test(name(node.key)))add('methods',name(node.key),node);
  if(node.type==='Literal'&&typeof node.value==='string'&&node.value.length>2&&node.value.length<160&&feature.test(node.value))add('uiStrings',node.value,node);
  if(node.type==='Property'&&['path','to','url','href'].includes(name(node.key))&&node.value?.type==='Literal'&&typeof node.value.value==='string'&&(node.value.value.startsWith('/')||node.value.value.startsWith('chrome:')))add('routes',node.value.value,node);
  if(node.type==='CallExpression'&&feature.test(name(node.callee))&&!/^console\./.test(name(node.callee)))add('bridgeCalls',name(node.callee),node);
  for(const [key,value]of Object.entries(node))if(!['loc','start','end'].includes(key)){if(Array.isArray(value))for(const child of value)visit(child);else if(value&&typeof value==='object')visit(value)}
 }
 visit(ast);if(found.methods.length||found.uiStrings.length>3||found.routes.length)report.resources.push(found);
}
for(const row of manifest.packs.find(p=>p.source.endsWith('en.lproj/locale.pak')).resources){if(row.id>=58000&&row.id<58200){const text=fs.readFileSync(path.join(root,row.path),'utf8');report.nativeLocaleStrings.push({id:row.id,path:row.path,sha256:row.decodedSha256,text})}}
fs.writeFileSync(path.join(root,'analysis/ego-client-static-index.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({resources:report.resources.length,nativeLocaleStrings:report.nativeLocaleStrings.length,routes:report.resources.flatMap(r=>r.routes.map(x=>({resource:r.id,value:x.value}))).slice(0,100)}));
for(const id of [58614,58639,58696,58707,58794,58796,58802,58836]){const r=report.resources.find(r=>r.id===id);if(r)console.log(JSON.stringify({id,methods:r.methods.map(x=>x.value),routes:r.routes.map(x=>x.value),uiStrings:r.uiStrings.map(x=>x.value).filter(s=>s.length<90).slice(0,70)}))}
