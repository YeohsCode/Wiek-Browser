'use strict';
// Synthetic local OAuth issuer/resource only. No accounts, external data or AI.
const http=require('node:http'),{randomUUID,createHash}=require('node:crypto');
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function createOAuthPeer(){
 const codes=new Map(),requests=[],tokens=[];let base;
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>32768){res.writeHead(413);res.end();return;}}
  const target=new URL(req.url,base);requests.push({method:req.method,path:target.pathname});
  const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  if(target.pathname==='/metadata')return json({resource:base+'/mcp',authorization_servers:[base],scopes_supported:['notes:read']});
  if(target.pathname==='/.well-known/oauth-authorization-server')return json({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',code_challenge_methods_supported:['S256'],response_types_supported:['code'],token_endpoint_auth_methods_supported:['none']});
  if(target.pathname==='/authorize'){
   const p=target.searchParams;if(p.get('client_id')!=='vek-public-fixture'||p.get('resource')!==base+'/mcp'||p.get('code_challenge_method')!=='S256')return json({},400);
   const fields=[...p].map(([key,value])=>`<input type="hidden" name="${html(key)}" value="${html(value)}">`).join('');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; form-action 'self'"});res.end(`<title>Wiek OAuth fixture</title><h1>Wiek OAuth fixture</h1><p>Synthetic permission notes:read. No real account data or model access.</p><form action="/grant" method="get">${fields}<button>Grant synthetic permission</button></form>`);return;
  }
  if(target.pathname==='/grant'){
   const p=target.searchParams;if(p.get('client_id')!=='vek-public-fixture'||p.get('resource')!==base+'/mcp'||p.get('code_challenge_method')!=='S256')return json({},400);
   let callback;try{callback=new URL(p.get('redirect_uri'));}catch{return json({},400)}if(callback.protocol!=='http:'||callback.hostname!=='127.0.0.1'||!callback.pathname.startsWith('/oauth/'))return json({},400);
   const code=randomUUID();codes.set(code,Object.fromEntries(p));callback.searchParams.set('code',code);callback.searchParams.set('state',p.get('state'));callback.searchParams.set('iss',base);res.writeHead(302,{location:callback.href,'cache-control':'no-store'});res.end();return;
  }
  if(target.pathname==='/token'){
   const p=new URLSearchParams(body),pending=codes.get(p.get('code'));if(p.get('grant_type')!=='authorization_code'||!pending||p.get('client_id')!=='vek-public-fixture'||p.get('resource')!==base+'/mcp'||p.get('redirect_uri')!==pending.redirect_uri||createHash('sha256').update(p.get('code_verifier')||'').digest('base64url')!==pending.code_challenge)return json({},400);codes.delete(p.get('code'));const token={access_token:'access-fixture-'+randomUUID(),refresh_token:'refresh-fixture-'+randomUUID(),token_type:'Bearer',expires_in:3600,scope:'notes:read'};tokens.push(token);return json(token);
  }
  if(target.pathname==='/mcp'){
   if(!tokens.some(row=>req.headers.authorization==='Bearer '+row.access_token)){res.writeHead(401,{'WWW-Authenticate':`Bearer resource_metadata="${base}/metadata", scope="notes:read"`});res.end();return;}
   if(req.method==='GET'){res.writeHead(405);res.end();return;}if(req.method==='DELETE'){res.writeHead(200);res.end();return;}
   let m;try{m=JSON.parse(body)}catch{return json({},400)}if(!Object.hasOwn(m,'id')){res.writeHead(202);res.end();return;}let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',serverInfo:{name:'oauth-local-fixture',version:'1'},capabilities:{tools:{}}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Synthetic OAuth protected tool',inputSchema:{type:'object'}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({authorized:true,credential:req.headers.authorization})}]};return json({jsonrpc:'2.0',id:m.id,result});
  }
  json({},404);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 return{url:base+'/mcp',base,requests,tokens,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
module.exports={createOAuthPeer};
