import {spawn} from 'node:child_process';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
export async function installOfflineTranslation({dataDir,python,root}){
  if(!isAbsolute(python)||python.includes('\0'))throw new Error('Specify an absolute Python 3.12 executable path');
  async function run(command,args,env=process.env){await new Promise((ok,no)=>{const child=spawn(command,args,{shell:false,stdio:'inherit',env});child.once('error',no);child.once('close',code=>code===0?ok():no(new Error('Translation installation failed: '+code)));});}
  await mkdir(dataDir,{recursive:true,mode:0o700});
  for(const directory of [join(dataDir,'translation-runtime'),join(dataDir,'translation')]){try{const st=await lstat(directory);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Invalid translation installation directory');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const environment=join(dataDir,'translation-runtime'),executable=join(environment,'bin/python');
  await run(python,['-m','venv',environment]);await run(executable,['-m','pip','install','argostranslate==1.11.0']);
  const directory=join(dataDir,'translation');await mkdir(directory,{recursive:true,mode:0o700});const adapter=join(root,'app/argos-translate.py');
  await run(executable,[adapter,'install'],{...process.env,VEK_TRANSLATION_DATA:join(directory,'models')});
  await writeFile(join(directory,'settings.json'),JSON.stringify({command:executable,args:[adapter],source:'en',target:'zh'},null,2),{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;console.log('Existing provider settings retained. Configure the installed runtime in Translation if needed.');});
  console.log('Offline English/Chinese translation installed in '+dataDir);
}
