'use strict';
const path=require('node:path');
function createSelectionToolbar({BrowserWindow,screen,ipcMain,consume,dismiss,copy,ask,translate,locale=()=>'en',onError=()=>{}}){
  let window=null,selection=null,generation=0,ready;
  function hide(){generation++;selection=null;if(window&&!window.isDestroyed())window.hide();}
  async function show(value){
    if(!value){hide();return;}const current=++generation;selection=value;
    if(!window||window.isDestroyed()){
      window=new BrowserWindow({width:290,height:48,show:false,frame:false,resizable:false,minimizable:false,maximizable:false,skipTaskbar:true,alwaysOnTop:true,title:'Wiek selection tools',backgroundColor:'#25314c',webPreferences:{preload:path.join(__dirname,'selection-toolbar-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
      window.on('closed',()=>{window=null;selection=null;});ready=window.loadFile(path.join(__dirname,'selection-toolbar.html'));
    }
    await ready;
    if(current!==generation||!selection)return;
    const point=screen.screenToDipPoint?screen.screenToDipPoint(value.point):value.point,area=screen.getDisplayNearestPoint(point).workArea;
    window.setBounds({x:Math.round(Math.max(area.x,Math.min(point.x,area.x+area.width-290))),y:Math.round(Math.max(area.y,Math.min(point.y+12,area.y+area.height-48))),width:290,height:48});window.webContents.send('vek:selection-toolbar', {id:value.id,appName:value.source.appName,locale:locale()});window.showInactive();
  }
  ipcMain.handle('vek:selection-toolbar:action',async(event,action,id)=>{
    if(!window||window.isDestroyed()||event.sender!==window.webContents||!selection||selection.id!==id||!['copy','ask','translate','dismiss'].includes(action))throw new Error('Selection toolbar expired');
    if(action==='dismiss'){dismiss(id);hide();return;}
    try{const value=consume(id);dismiss(id);hide();if(action==='copy')copy(value.text);else if(action==='ask')ask(value.text);else await translate(value.text);return {ok:true};}catch(error){hide();onError(error.message);throw error;}
  });
  return {show,hide,close(){hide();if(window&&!window.isDestroyed())window.destroy();ipcMain.removeHandler('vek:selection-toolbar:action');}};
}
module.exports={createSelectionToolbar};
