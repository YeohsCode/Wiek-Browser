'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// The main process supplies at most one archive session for this exact
// top-level document. It runs in the preload before website scripts.
if (process.isMainFrame && process.argv.includes('--wiek-import-session') && /^https?:/.test(location.href)) {
  const entries = ipcRenderer.sendSync('wiek:restore-tab-session', location.href);
  if (entries) {
    const decode = value => {
      const bytes = atob(value);
      let result = '';
      for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8));
      return result;
    };
    let restored = false;
    try {
      const storage = window.sessionStorage;
      if (storage.length === 0) {
        try {
          for (const [key, value] of entries) storage.setItem(decode(key), decode(value));
          restored = true;
        } catch {
          storage.clear();
        }
      }
    } catch {
      // Storage can be unavailable for a document with a sandboxed origin.
    } finally {
      ipcRenderer.sendSync('wiek:restore-tab-session-result', location.href, restored);
    }
  }
}

// Electron has no Chromium prompt handler. This narrow bridge blocks only page
// JavaScript until the user or agent resolves the authored dialog.
contextBridge.exposeInMainWorld('__vekPrompt', (message = '', defaultValue = '') => ipcRenderer.sendSync('vek:page-prompt', String(message), String(defaultValue)));
contextBridge.executeInMainWorld({ func: () => { window.prompt = function prompt(message = '', defaultValue = '') { return window.__vekPrompt(String(message), String(defaultValue)); }; } });

// Optional, explicitly enabled local recording and selection controls. The page
// receives no IPC function, token, filesystem API, or means to enable recording.
let selectionLabels = {};
let recording = false, selectionOptions = {enabled:false}, toolbar, selectedText = '', selectionTimer, scrollTimer;
ipcRenderer.on('vek:page-config', (_event, config) => {
  recording = config.recording === true;
  selectionLabels = config.selectionLabels || {};
  if(config.selectionToolbar)selectionOptions=config.selectionToolbar;
  if(!selectionOptions.enabled)toolbar?.remove();
});
const clipped = value => String(value || '').slice(0,200);
function elementMetadata(event) {
  const element=event.composedPath().find(item=>item instanceof Element);
  if(!element)return {};
  const target={tagName:element.tagName.toLowerCase(),type:clipped(element.getAttribute('type')),autocomplete:clipped(element.getAttribute('autocomplete')),name:clipped(element.getAttribute('name')),id:clipped(element.id)};
  const sensitive=target.type==='password'||/password|passcode|credit|cardnumber|cc-|payment|otp|one-time-code/i.test([target.type,target.autocomplete,target.name,target.id].join(' '));
  const rect=element.getBoundingClientRect();
  return {target,sensitive,selector:target.id?`#${CSS.escape(target.id)}`:target.tagName,box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
}
function record(event,kind,extra={}) {
  if(!recording||!event.isTrusted||event.composedPath().some(node=>node instanceof Element&&node.id==='__vek-selection-tools'))return;
  const metadata=elementMetadata(event);if(metadata.sensitive)return;
  ipcRenderer.send('vek:page-action',{kind,url:location.href,...metadata,...extra});
}
window.addEventListener('click',event=>record(event,'click',{x:event.clientX,y:event.clientY}),true);
window.addEventListener('keydown',event=>{
  if(event.key==='Escape')toolbar?.remove();
  if(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)||event.ctrlKey||event.metaKey)record(event,'key',{key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey});
},true);
window.addEventListener('scroll',event=>{if(!recording||!event.isTrusted)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>record(event,'scroll',{x:scrollX,y:scrollY}),200);},{passive:true,capture:true});
function displaySelection() {
  toolbar?.remove();if(!selectionOptions.enabled)return;
  const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return;
  const anchor=selection.anchorNode?.parentElement;
  if(anchor?.closest('input,textarea,[contenteditable=true]'))return;
  selectedText=selection.toString().trim().slice(0,50000);if(!selectedText)return;
  const rect=selection.getRangeAt(0).getBoundingClientRect();
  toolbar=document.createElement('div');toolbar.id='__vek-selection-tools';
  Object.assign(toolbar.style,{position:'fixed',left:`${Math.max(8,Math.min(rect.left,innerWidth-250))}px`,top:`${Math.max(8,Math.min(rect.bottom+8,innerHeight-55))}px`,zIndex:'2147483647'});
  const shadow=toolbar.attachShadow({mode:'closed'}),box=document.createElement('div');box.style.cssText='display:flex;gap:4px;padding:5px;background:#25314c;color:white;border:1px solid #657296;border-radius:9px;box-shadow:0 3px 15px #0004;font:12px system-ui;';
  for(const [action,label] of [['copy','Copy'],['save','Save selection'],['ask','Ask Agent'],['translate','Translate']])if(selectionOptions[action]){const button=document.createElement('button');button.textContent=selectionLabels[action]||label;button.style.cssText='font:inherit;border:0;background:transparent;color:white;cursor:pointer;padding:7px;border-radius:5px;';button.onmousedown=event=>event.preventDefault();button.onclick=event=>{if(!event.isTrusted)return;ipcRenderer.send('vek:selection-action',{action,text:selectedText});toolbar.remove();};box.append(button);}
  shadow.append(box);document.documentElement.append(toolbar);
}
document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(displaySelection,180);});
