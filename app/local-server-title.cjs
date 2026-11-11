'use strict';
// Independent, bounded metadata reader. No browser session, DOM, script or DNS.
const http = require('node:http');
const invalid = message => Object.assign(new Error(message), {error_code: 'WIEK_LOCAL_TITLE_INVALID'});
function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('Choose a listed loopback address'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || Number(url.port || 80) < 1 || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw invalid('Choose a listed loopback address');
  return url;
}
function text(value) {
  const named = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '};
  const decoded = value.replace(/&([^;\s]{1,16});/g, (whole, entity) => {
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) return whole;
    const code = /^#x/i.test(entity) ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  }).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
  return [...decoded].slice(0,200).join('');
}
function attributes(tag) {
  const output = Object.create(null);
  // Anchored scanning consumes every token once, including long malformed
  // attributes without '=', rather than retrying a greedy search at each byte.
  const pattern=/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+)))?/y;
  for(let cursor=0;cursor<tag.length;){
    while(cursor<tag.length&&/\s/.test(tag[cursor]))cursor++;
    pattern.lastIndex=cursor;const match=pattern.exec(tag);
    if(!match){cursor++;continue;}cursor=pattern.lastIndex;
    const name = match[1].toLowerCase();
    if (!Object.hasOwn(output,name)) output[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return output;
}
function titleFromHtml(html) {
  // Parse only bounded head metadata. Raw-text/hidden regions cannot supply a
  // fake title. This is deliberately not a complete HTML or charset engine.
  let cursor = 0, fallback = '';
  const hidden = [];
  const metas = new Map();
  while (cursor < html.length) {
    const begin = html.indexOf('<', cursor);
    if (begin < 0) break;
    if (html.startsWith('<!--', begin)) {
      const end = html.indexOf('-->', begin+4); if (end < 0) break;
      cursor = end+3; continue;
    }
    let end=begin+1, quote='';
    for (;end<html.length;end++) {
      const c=html[end];
      if (quote) { if(c===quote)quote=''; }
      else if(c==='"'||c==="'")quote=c;
      else if(c==='>')break;
    }
    if(end===html.length)break;
    const token=html.slice(begin+1,end),match=/^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(token);
    cursor=end+1;if(!match)continue;
    const closing=!!match[1],name=match[2].toLowerCase();
    if(['template','svg','math'].includes(name)) {
      if(closing) { if(hidden.at(-1)===name)hidden.pop(); }
      else hidden.push(name);
      continue;
    }
    if(!closing&&['script','style','textarea','noscript','iframe','title'].includes(name)) {
      const close=new RegExp('</'+name+'\\s*>','ig');close.lastIndex=cursor;
      const found=close.exec(html);if(!found)break;
      if(name==='title'&&!hidden.length&&!fallback)fallback=text(html.slice(cursor,found.index));
      cursor=close.lastIndex;continue;
    }
    if(hidden.length)continue;
    if(name==='body'||name==='head'&&closing)break;
    if(closing)continue;
    if(name==='meta') {
      const values=attributes(token.slice(match[0].length)),key=(values.name||values.property||'').toLowerCase();
      if(['application-name','og:title','twitter:title'].includes(key)&&!metas.has(key))metas.set(key,text(values.content||''));
    }
  }
  return metas.get('application-name')||metas.get('og:title')||metas.get('twitter:title')||fallback||null;
}
function readLocalTitle(value,{signal,timeoutMs=2000,maxBytes=128*1024}={}) {
  const url=endpoint(value);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>128*1024)throw invalid('Invalid title read limits');
  if(signal?.aborted)return Promise.reject(invalid('Title read cancelled'));
  return new Promise((resolve,reject)=>{
    let complete=false,bytes=0;const chunks=[];
    const finish=(error,result)=>{
      if(complete)return;complete=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      request.destroy();error?reject(error):resolve(result);
    };
    const abort=()=>finish(invalid('Title read cancelled'));
    const request=http.get(url,{agent:false,headers:{Accept:'text/html,application/xhtml+xml','Accept-Encoding':'identity','User-Agent':'WiekLocalServices/1.0'}},response=>{
      const type=String(response.headers['content-type']||'').toLowerCase();
      const encoding=String(response.headers['content-encoding']||'identity').toLowerCase();
      const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1];
      if(response.statusCode<200||response.statusCode>=300||!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/.test(type)||encoding!=='identity'||charset&&!['utf-8','utf8','us-ascii'].includes(charset)) {
        response.destroy();finish(null,{title:null,status:'unsupported'});return;
      }
      const done=()=>finish(null,{title:titleFromHtml(Buffer.concat(chunks).toString('utf8')),status:'read',bytesRead:bytes});
      response.on('data',chunk=>{
        const part=chunk.subarray(0,Math.max(0,maxBytes-bytes));chunks.push(part);bytes+=part.length;
        if(bytes===maxBytes){done();response.destroy();}
      });
      response.once('end',done);response.once('error',()=>finish(invalid('Title response ended unexpectedly')));
      response.once('aborted',()=>{if(!complete)finish(invalid('Title response ended unexpectedly'));});
    });
    const timer=setTimeout(()=>finish(invalid('Title read timed out')),timeoutMs);
    request.once('error',()=>finish(invalid('Title endpoint is unavailable')));
    signal?.addEventListener('abort',abort,{once:true});
  });
}
module.exports={readLocalTitle,titleFromHtml};
