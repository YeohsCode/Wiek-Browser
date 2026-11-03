'use strict';const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{focus:()=>ipcRenderer.send('fixture:focus')});
