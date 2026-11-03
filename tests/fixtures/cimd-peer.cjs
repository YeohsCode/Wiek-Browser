'use strict';
// Disposable HTTPS issuer, metadata publisher and protected resource. Test CA only.
const https=require('node:https'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
async function createTestTLS(){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vek-cimd-tls-')),keyFile=path.join(directory,'key.pem'),certFile=path.join(directory,'cert.pem'),configuration=path.join(directory,'openssl.cnf');await fs.writeFile(configuration,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Wiek disposable test CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',keyFile,'-out',certFile,'-config',configuration],{stdio:'ignore'});return{directory,key:await fs.readFile(keyFile),cert:await fs.readFile(certFile),certFile,close:()=>fs.rm(directory,{recursive:true,force:true})};}
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function request(endpoint,{method='GET',body,headers={}}={}){return new Promise((resolve,reject)=>{const u=new URL(endpoint),r=(u.protocol==='https:'?https:http).request(u,{method,headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});r.on('error',reject);r.end(body);});}
async function createCimdPeer(tls,settings={}){
 const requests=[],tokens=[],codes=new Map(),sockets=new Set();let base,issued=0;
 const redirectPort=settings.redirectPort||await freePort();
 const document=()=>({client_id:base+'/client.json',client_name:'Wiek fixture <script>inert</script>',redirect_uris:[`http://127.0.0.1:${redirectPort}/oauth/callback`],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',...settings.document});
 const server=https.createServer({key:tls.key,cert:tls.cert},async(req,res)=>{try{
  let body='';for await(const b of req)body+=b;const u=new URL(req.url,base),form=new URLSearchParams(body);requests.push({method:req.method,path:u.pathname,authorization:req.headers.authorization,cookie:req.headers.cookie,form:Object.fromEntries(form),query:Object.fromEntries(u.searchParams)});const json=(data,status=200,media='application/json')=>res.writeHead(status,{'content-type':media}).end(JSON.stringify(data));
  if(u.pathname==='/client.json'){
   if(settings.documentDelay)await new Promise(r=>setTimeout(r,settings.documentDelay));
   if(settings.documentRedirect)return res.writeHead(302,{location:base+'/elsewhere'}).end();
   if(settings.documentRaw!==undefined)return res.writeHead(200,{'content-type':settings.documentMedia||'application/json'}).end(settings.documentRaw);
   return json(document(),settings.documentStatus||200,settings.documentMedia||'application/json');
  }
  if(u.pathname==='/resource')return json({resource:base+'/mcp',authorization_servers:[base+(settings.issuerPath||'')],scopes_supported:['notes:read']});
  if(u.pathname.startsWith('/.well-known/'))return json({issuer:base+(settings.issuerPath||''),authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],response_types_supported:['code'],authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:settings.supported===undefined?true:settings.supported,registration_endpoint:base+'/register'});
  if(u.pathname==='/authorize'){
   const p=u.searchParams;const d=JSON.parse((await request(base+'/client.json')).text);
   if(p.get('client_id')!==base+'/client.json'||d.client_id!==p.get('client_id')||!d.redirect_uris.includes(p.get('redirect_uri'))||p.get('code_challenge_method')!=='S256'||p.get('resource')!==base+'/mcp')return json({},400);
   const code=randomUUID();codes.set(code,Object.fromEntries(p));const callback=new URL(p.get('redirect_uri'));callback.searchParams.set('code',code);callback.searchParams.set('state',p.get('state'));callback.searchParams.set('iss',base+(settings.issuerPath||''));return res.writeHead(302,{location:callback.href}).end();
  }
  if(u.pathname==='/token'){
   if(settings.tokenFailure)return json({},503);
   if(form.get('client_id')!==base+'/client.json'||form.get('resource')!==base+'/mcp'||req.headers.authorization)return json({},400);
   if(form.get('grant_type')==='authorization_code'){const saved=codes.get(form.get('code'));if(!saved||saved.redirect_uri!==form.get('redirect_uri')||createHash('sha256').update(form.get('code_verifier')||'').digest('base64url')!==saved.code_challenge)return json({},400);codes.delete(form.get('code'));}else if(form.get('grant_type')!=='refresh_token'||form.get('refresh_token')!==tokens.at(-1)?.refresh_token)return json({},400);
   const token={access_token:'cimd-access-'+randomUUID(),refresh_token:'cimd-refresh-'+randomUUID(),token_type:'Bearer',expires_in:++issued===1?settings.expiresIn||3600:3600,scope:'notes:read'};tokens.push(token);return json(token);
  }
  if(u.pathname==='/mcp'){
   if(!tokens.some(t=>req.headers.authorization==='Bearer '+t.access_token)){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${base}/resource", scope="notes:read"`}).end();return;}
   if(req.method==='GET'){res.writeHead(405).end();return;}
   if(req.method==='DELETE'){res.writeHead(200).end();return;}
   const m=JSON.parse(body);if(!Object.hasOwn(m,'id')){res.writeHead(202).end();return;}
   let result={};if(m.method==='initialize')result={protocolVersion:'2025-11-25',serverInfo:{name:'CIMD fixture'},capabilities:{tools:{}}};if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};if(m.method==='tools/call')result={content:[{type:'text',text:'authorized '+req.headers.authorization}]};return json({jsonrpc:'2.0',id:m.id,result});
  }
  return json({},404);
 }catch{res.destroy();}});
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`https://127.0.0.1:${server.address().port}`;
 return {base,url:base+'/mcp',clientId:base+'/client.json',redirectPort,requests,tokens,settings,document,close:async()=>{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
module.exports={createTestTLS,createCimdPeer,freePort,request};
