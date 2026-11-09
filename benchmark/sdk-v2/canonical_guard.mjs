// A syntactic isolation guard, not a sandbox for arbitrary agent JavaScript.
// Parse actual JavaScript: comments and quoted examples never establish scope.
import {parse} from './_canonical_acorn.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
try {
  const {source,taskId=null}=JSON.parse(input);
  if(typeof source!=='string'||source.length>262144)throw new Error('Inline script exceeds guard limit');
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module',allowAwaitOutsideFunction:true});
  const candidates=[],calls=[];let release=false;
  function walk(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='taskSpace'){
      const arg=node.arguments[0];
      const literal=!node.optional&&node.arguments.length===1&&arg?.type==='Literal'&&['string','number'].includes(typeof arg.value);
      calls.push(literal?arg.value:null);
      if(literal&&!candidates.includes(arg.value))candidates.push(arg.value);
    }
    if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.property.name==='finish')release=true;
    if(taskId!==null&&node.type==='Identifier'){
      const property=parent?.type==='MemberExpression'&&parent.property===node&&!parent.computed;
      if(node.name==='taskSpace'&&!(parent?.type==='CallExpression'&&parent.callee===node))throw new Error('taskSpace must be called directly with the literal task name');
      if(!property&&['wiek','globalThis','eval','Function','require','taskSpaces','useOrCreateTaskSpace','newTaskSpace','switchTaskSpace','claimTaskSpace','takeOverTaskSpace','handOffTaskSpace','completeTaskSpace'].includes(node.name))throw new Error(`Unsupported control surface in strict V2 script: ${node.name}`);
    }
    if(taskId!==null&&node.type==='ImportExpression')throw new Error('Imports are outside the strict inline guard contract');
    for(const [key,value] of Object.entries(node)){
      if(key==='start'||key==='end')continue;
      if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,node);}
      else if(value?.type)walk(value,node);
    }
  }
  walk(tree);
  if(taskId!==null&&(!calls.length||calls.some(value=>value!==taskId)))throw new Error(`Every taskSpace call must use the literal name ${JSON.stringify(taskId)}`);
  process.stdout.write(JSON.stringify({ok:true,candidates,release}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error.message||error)}));process.exitCode=1;}
