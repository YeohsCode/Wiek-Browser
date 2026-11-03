'use strict';
const fs=require('node:fs'),path=require('node:path');
// Keep existing integrations and SDK inputs usable during the name transition.
// Explicit WIEK_* values win when both names are supplied.
function normalizeEnvironment(env=process.env){
  for(const [name,value] of Object.entries(env))if(name.startsWith('WIEK_'))env['VEK_'+name.slice(5)]=value;
  for(const [name,value] of Object.entries(env))if(name.startsWith('VEK_')&&env['WIEK_'+name.slice(4)]===undefined)env['WIEK_'+name.slice(4)]=value;
  return env;
}
function packagedDataDirectory(base,{exists=fs.existsSync}={}){
  const current=path.join(base,'Wiek Browser'),legacy=path.join(base,'Vek Browser');
  return exists(current)?current:exists(legacy)?legacy:current;
}
module.exports={normalizeEnvironment,packagedDataDirectory};
