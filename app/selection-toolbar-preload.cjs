const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('selectionTools',{onSelection:fn=>ipcRenderer.on('vek:selection-toolbar',(_,value)=>fn(value)),action:(action,id)=>ipcRenderer.invoke('vek:selection-toolbar:action',action,id)});
