#!/usr/bin/env node
// Authored SVGs are the source of truth. This build tool does not read third-party assets.
import {readFile,writeFile,mkdir,copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';
const root=fileURLToPath(new URL('..',import.meta.url));
const assets=join(root,'app/assets');
const svg=await readFile(join(assets,'wiek.svg'),'utf8');
const tray=await readFile(join(assets,'wiek-tray.svg'),'utf8');
const png=(source,size)=>new Resvg(source,{fitTo:{mode:'width',value:size},font:{loadSystemFonts:false}}).render().asPng();
await writeFile(join(assets,'wiek.png'),png(svg,1024));
await writeFile(join(assets,'wiek-trayTemplate.png'),png(tray,18));
await writeFile(join(assets,'wiek-trayTemplate@2x.png'),png(tray,36));
for(const skill of ['wiek-browser']){
  const dir=join(root,'skills',skill,'assets');await mkdir(dir,{recursive:true});
  await copyFile(join(assets,'wiek.png'),join(dir,'logo.png'));
  await writeFile(join(dir,'composer-icon.png'),png(svg,128));
}
if(process.platform==='darwin'){
  const temporary=await mkdtemp(join(tmpdir(),'wiek-icons-'));
  try{
    const iconset=join(temporary,'wiek.iconset');await mkdir(iconset);
    for(const size of [16,32,128,256,512])for(const scale of [1,2])
      await writeFile(join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`),png(svg,size*scale));
    execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',resolve(assets,'wiek.icns')]);
  }finally{await rm(temporary,{recursive:true,force:true});}
}
console.log('Generated independent Wiek app, Dock, tray and Skill artwork.');
