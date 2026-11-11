'use strict';
// Standalone, hidden Electron probe. Does not launch Wiek's main browser or SDK.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
if(!process.versions.electron){
  const result=require('node:child_process').spawnSync(require('electron'),[__filename],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  process.exit(result.status??1);
}
const {app,BrowserWindow,ipcMain}=require('electron');
app.on('window-all-closed',()=>{});
const {createLibraryService}=require('../app/library-service.cjs');
let service,window,dataDir,watchdog;
async function finish(code){clearTimeout(watchdog);await service?.close();window?.destroy();if(dataDir)await fs.rm(dataDir,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
  watchdog=setTimeout(()=>{console.error('Library Electron pixel probe timed out');void finish(1);},30000);
  dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'vek-library-electron-'));
  const output=path.join(__dirname,'../reports/library-annotation-electron.png');
  window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});
  await window.loadURL('data:text/html,<html><body><main id="library"></main></body></html>');
  const base64=await window.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,320,180);return c.toDataURL('image/png').split(',')[1]})()`);
  service=createLibraryService({dataDir,capture:async()=>({pngBase64:base64,title:'Electron canvas fixture',url:'https://example.test/'}),exportImage:async({pngBase64})=>{await fs.writeFile(output,Buffer.from(pngBase64,'base64'));return{saved:true,path:output};},onChange:snapshot=>void window.webContents.executeJavaScript(`window.WiekLibraryPanel.update(${JSON.stringify(snapshot)})`).catch(()=>{})});
  ipcMain.handle('library-pixel-action',async(_event,action,payload)=>service.dispatch(action,payload));
  const css=await fs.readFile(path.join(__dirname,'../app/library-panel.css'),'utf8');
  await window.webContents.executeJavaScript(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);document.body.style='font-family:system-ui;margin:28px;background:#f9fbff'})()`);
  await window.webContents.executeJavaScript(await fs.readFile(path.join(__dirname,'../app/library-panel.js'),'utf8'));
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const root=document.getElementById('library'),ipc=require('electron').ipcRenderer;
    const invoke=(a,p)=>ipc.invoke('library-pixel-action',a,p),tick=()=>new Promise(r=>setTimeout(r,10));
    const check=(test,message)=>{if(!test)throw new Error(message)};
    const ready=async()=>{for(let i=0;i<300;i++){const c=root.querySelector('.vl-canvas');if(c?.dataset.ready==='true')return c;await tick()}throw new Error('Canvas did not load')};
    const click=async label=>{const scope=root.querySelector('.vl-capture-card')||root,button=[...scope.querySelectorAll('button')].find(b=>b.textContent===label);check(button&&!button.disabled,label+' enabled');button.click();await tick()};
    const pointer=(c,type,x,y)=>{const box=c.getBoundingClientRect();return c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:box.left+x*box.width/c.width,clientY:box.top+y*box.height/c.height,button:0,pointerId:1}))};
    const drag=async(tool,x1,y1,x2,y2)=>{await click(tool);const c=await ready();pointer(c,'pointerdown',x1,y1);pointer(c,'pointermove',x2,y2);pointer(c,'pointerup',x2,y2);return ready()};
    const pixel=(c,x,y)=>[...c.getContext('2d').getImageData(x,y,1,1).data],red=p=>p[0]>170&&p[1]<170&&p[2]<170;
    window.WiekLibraryPanel.mount(root,invoke);await tick();await window.WiekLibraryPanel.capture();let canvas=await ready();
    check(canvas.width===320&&(await invoke('library:snapshot')).counts.active===0,'Capture draft remains unsaved');
    canvas=await drag('Rectangle',20,20,100,70);check(red(pixel(canvas,20,40)),'Rectangle changes actual pixels');
    canvas=await drag('Arrow',130,30,220,90);check(red(pixel(canvas,175,60)),'Arrow changes actual pixels');
    await click('Text');canvas=await ready();const label=root.querySelector('[data-focus="annotation-text"]');label.value='Test';label.dispatchEvent(new Event('input'));pointer(canvas,'pointerdown',20,105);canvas=await ready();let ink=0;const bytes=canvas.getContext('2d').getImageData(20,105,70,35).data;for(let i=0;i<bytes.length;i+=4)if(bytes[i+1]<180)ink++;check(ink>30,'Text produces glyph pixels');
    await click('Crop');canvas=await ready();pointer(canvas,'pointerdown',10,10);pointer(canvas,'pointermove',250,150);pointer(canvas,'pointerup',250,150);await click('Export PNG');await ready();
    await click('Apply crop');canvas=await ready();check(canvas.width===240&&canvas.height===140,'Crop dimensions');check(red(pixel(canvas,10,30)),'Crop preserves image coordinates');
    await click('Undo');canvas=await ready();check(canvas.width===320&&canvas.height===180,'Undo restores original dimensions');await click('Redo');canvas=await ready();check(canvas.width===240,'Redo restores crop');
    await click('Export PNG');await ready();await click('Save item');
    const snapshot=await invoke('library:snapshot');check(snapshot.counts.active===1,'Persistent image saved');check(snapshot.items[0].image.width===240&&snapshot.items[0].image.height===140,'Persisted PNG dimensions');
    const saved=await invoke('library:items:read',{id:snapshot.items[0].id});check(saved.dataUrl.startsWith('data:image/png;base64,'),'Saved real PNG bytes');
    const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=saved.dataUrl});const probe=document.createElement('canvas');probe.width=image.width;probe.height=image.height;probe.getContext('2d').drawImage(image,0,0);check(pixel(probe,0,0).slice(0,3).every(v=>v===255),'Crop guides excluded from saved PNG');
    return{width:image.width,height:image.height,active:snapshot.counts.active,assertions:12};
  })()`);
  await fs.writeFile(path.join(__dirname,'../reports/library-panel-electron-ui.png'),(await window.webContents.capturePage()).toPNG());
  console.log('Library hidden Electron canvas pixel probe PASS '+JSON.stringify(result));
  await finish(0);
}).catch(async error=>{console.error(error);await finish(1);});
